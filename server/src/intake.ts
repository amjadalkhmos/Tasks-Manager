import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { FORBIDDEN, projectAccess } from "./access.js";
import type { DB, Queryable } from "./db.js";
import { logActivity, notify } from "./events.js";
import { HttpError, parseId } from "./http-error.js";
import { statusFor } from "./statuses.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

/** A tiny in-memory limiter: at most `max` hits per `windowMs` for each key. Enough to blunt a form being hammered. */
export function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k); // keep the table small
    return true;
  };
}

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const ticketForm = z.object({
  name: z.string().trim().min(1, "Please tell us your name").max(100),
  email: z.string().trim().email("Please enter a valid email address").max(200),
  subject: z.string().trim().min(1, "Please add a subject").max(200),
  message: z.string().trim().min(1, "Please describe the problem").max(5000),
  /** A field real visitors never see; bots fill it in. */
  website: z.string().max(200).optional(),
});

/** "Jane Doe <jane@example.com>" or a bare address. */
export function parseAddress(from: string): { name: string; email: string } | null {
  const m = from.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/);
  const email = (m ? m[2] : from).trim().toLowerCase();
  if (!z.string().email().safeParse(email).success) return null;
  const name = (m?.[1] ?? "").trim() || email.split("@")[0];
  return { name: name.slice(0, 100), email };
}

/** Keeps the new words of an emailed reply, dropping the quoted history below them. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex((l, i) => i > 0 && (/^On .+wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) || /^_{5,}$/.test(l.trim()) || /^From:\s.+/.test(l) && /^(Sent|Date):/i.test(lines[i + 1] ?? "")));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l, i, a) => !(/^>/.test(l) && a.slice(i).every((x) => /^>|^\s*$/.test(x))));
  const out = kept.join("\n").trim();
  return out || text.trim();
}

const looksAutomatic = (email: string) => /^(mailer-daemon|postmaster|no-?reply|donotreply)@/i.test(email);

export function registerIntake(app: Express, { db, auth, uid }: Deps) {
  const formLimit = rateLimiter(5, 15 * 60_000); // per visitor and desk
  const deskLimit = rateLimiter(200, 60 * 60_000); // per desk, in total
  const mailLimit = rateLimiter(120, 60_000);
  const probeLimit = rateLimiter(60, 60_000); // lookups per address, so desk links can't be guessed

  interface Desk {
    id: number;
    name: string;
    user_id: number;
    workspace_id: number | null;
    lead_id: number | null;
    stage: string;
  }

  const findDesk = async (token: string): Promise<Desk> => {
    const desk = TOKEN.test(token)
      ? await db.get<Desk>("SELECT id, name, user_id, workspace_id, lead_id, stage FROM projects WHERE intake_token = ? AND type = 'support'", token)
      : undefined;
    if (!desk) throw new HttpError(404, "This support desk isn't available");
    if (desk.stage === "archived" || desk.stage === "completed") throw new HttpError(410, "This support desk isn't taking new tickets");
    return desk;
  };

  /** Whoever should hear about a new ticket: the project's lead, else the people who run the workspace, else the owner. */
  const recipients = async (q: Queryable, desk: Desk): Promise<number[]> => {
    if (desk.lead_id !== null) {
      const ok = desk.workspace_id === null ? desk.lead_id === desk.user_id : !!(await q.get("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?", desk.workspace_id, desk.lead_id));
      if (ok) return [desk.lead_id];
    }
    if (desk.workspace_id === null) return [desk.user_id];
    return (await q.all<{ user_id: number }>("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role IN ('owner','admin')", desk.workspace_id)).map((r) => r.user_id);
  };

  const ticketFrom = async (desk: Desk, who: { name: string; email: string }, subject: string, message: string, source: "form" | "email") => {
    return db.tx(async (t) => {
      const no = (await t.get<{ n: number }>("SELECT COALESCE(MAX(ticket_no), 0) + 1 AS n FROM tasks WHERE project_id = ?", desk.id))!.n;
      const statusId = await statusFor(t, desk.id, desk.workspace_id, "todo");
      const taskId = await t.insert(
        `INSERT INTO tasks (user_id, project_id, title, notes, status, status_id, position, requester_name, requester_email, source, ticket_no)
         VALUES (?, ?, ?, ?, 'todo', ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE project_id = ?), ?, ?, ?, ?)`,
        desk.user_id, desk.id, subject, message, statusId, desk.id, who.name, who.email, source, no,
      );
      await logActivity(t, desk.workspace_id, desk.user_id, "task_created", taskId, { title: subject });
      for (const u of await recipients(t, desk)) await notify(t, { userId: u, kind: "ticket", actorId: null, taskId, workspaceId: desk.workspace_id, title: `#${no} ${subject}` });
      return { taskId, no };
    });
  };

  /** A customer's emailed reply joins its ticket, reopening it if it was finished. Returns false if it doesn't belong to one. */
  const replyTo = async (desk: Desk, ticketNo: number, who: { name: string; email: string }, message: string): Promise<boolean> => {
    const task = await db.get<{ id: number; title: string; status: string; requester_email: string | null }>(
      "SELECT id, title, status, requester_email FROM tasks WHERE project_id = ? AND ticket_no = ?", desk.id, ticketNo,
    );
    // Only the person who raised the ticket can add to it by email; anyone else starts their own.
    if (!task || (task.requester_email ?? "").toLowerCase() !== who.email) return false;
    await db.tx(async (t) => {
      await t.insert("INSERT INTO comments (task_id, user_id, body, requester) VALUES (?, ?, ?, ?)", task.id, desk.user_id, message, who.name);
      if (task.status === "done") {
        await t.run("UPDATE tasks SET status = 'todo', status_id = ?, completed_at = NULL WHERE id = ?", await statusFor(t, desk.id, desk.workspace_id, "todo"), task.id);
      }
      for (const u of await recipients(t, desk)) await notify(t, { userId: u, kind: "commented", actorId: null, taskId: task.id, workspaceId: desk.workspace_id, title: `#${ticketNo} ${task.title}` });
    });
    return true;
  };

  // ---------- the public form ----------
  app.get("/api/public/support/:token", async (req, res) => {
    if (!probeLimit(String(req.ip))) throw new HttpError(429, "Too many requests");
    const desk = await findDesk(String(req.params.token));
    res.json({ name: desk.name });
  });

  app.post("/api/public/support/:token", async (req, res) => {
    const token = String(req.params.token);
    if (!probeLimit(String(req.ip))) throw new HttpError(429, "Too many requests");
    const desk = await findDesk(token);
    if (!formLimit(`${req.ip}|${token}`) || !deskLimit(token)) throw new HttpError(429, "Too many requests. Please try again later.");
    const b = ticketForm.parse(req.body);
    // A filled-in hidden field means a bot: answer as if it worked, and keep nothing.
    if (b.website) return void res.status(201).json({ ticket_no: null });
    const { no } = await ticketFrom(desk, { name: b.name, email: b.email.toLowerCase() }, b.subject, b.message, "form");
    res.status(201).json({ ticket_no: no });
  });

  // ---------- inbound email ----------
  // Point your mail provider's "inbound" or "forward to URL" feature here. JSON (including Postmark's format) and
  // form-encoded (Mailgun, SendGrid-style) bodies are accepted.
  app.post("/api/intake/email/:token", express.urlencoded({ extended: false, limit: "2mb" }), async (req, res) => {
    const token = String(req.params.token);
    if (!probeLimit(String(req.ip))) throw new HttpError(429, "Too many requests");
    const desk = await findDesk(token);
    if (!mailLimit(token)) throw new HttpError(429, "Too many requests");
    const b = (req.body ?? {}) as Record<string, any>;
    const from = typeof b.FromFull?.Email === "string" ? `${b.FromFull.Name ?? ""} <${b.FromFull.Email}>` : String(b.from ?? b.From ?? b.sender ?? "");
    const subject = String(b.subject ?? b.Subject ?? "").trim().slice(0, 200);
    const text = String(b.text ?? b.TextBody ?? b["body-plain"] ?? b.plain ?? "");
    const who = parseAddress(from);
    if (!who || looksAutomatic(who.email)) return void res.status(202).json({ ignored: "sender" }); // acknowledge, so the provider doesn't retry
    const message = stripQuoted(text).slice(0, 5000);
    if (!message) return void res.status(202).json({ ignored: "empty" });

    const ref = subject.match(/\[#(\d{1,9})\]/);
    if (ref && (await replyTo(desk, Number(ref[1]), who, message))) return void res.status(201).json({ ticket_no: Number(ref[1]), reply: true });
    const { no } = await ticketFrom(desk, who, subject || "(no subject)", message, "email");
    res.status(201).json({ ticket_no: no, reply: false });
  });

  // ---------- turning the intake on and off ----------
  app.post("/api/projects/:id/intake", auth, async (req, res) => {
    const b = z.object({ enabled: z.boolean(), rotate: z.boolean().optional() }).parse(req.body);
    const pa = await projectAccess(db, uid(req), parseId(req.params.id, "Project not found"));
    if (!pa) throw new HttpError(404, "Project not found");
    if (!(pa.workspaceId === null || pa.canManage)) throw FORBIDDEN();
    const p = await db.get<{ type: string; intake_token: string | null }>("SELECT type, intake_token FROM projects WHERE id = ?", pa.id);
    if (p?.type !== "support") throw new HttpError(400, "Only support projects take tickets from outside");
    const token = !b.enabled ? null : b.rotate || !p.intake_token ? randomBytes(18).toString("base64url") : p.intake_token;
    await db.run("UPDATE projects SET intake_token = ? WHERE id = ?", token, pa.id);
    res.json({ enabled: token !== null, token });
  });
}
