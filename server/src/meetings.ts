import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import {
  FORBIDDEN, atLeast, readableMeeting, readableTask, requireRole, taskAccess, visibleMeetingsSql, writableMeeting,
  type MeetingAccess, type MeetingRow, type Role,
} from "./access.js";
import { inChunks, type DB, type Queryable } from "./db.js";
import { logActivity } from "./events.js";
import { HttpError, parseId } from "./http-error.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

const iso = z.string().datetime({ offset: true });
const DEFAULT_LENGTH_MIN = 30;
const MAX_LIST = 500;

/** Only web links are accepted: the value is rendered as a clickable link, so "javascript:" and friends must never get in. */
export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const fields = {
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(10000),
  starts_at: iso,
  ends_at: iso,
  location: z.string().trim().max(200),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || isHttpUrl(v), "The meeting link must start with http:// or https://"),
};
// Only these fields can be set by a client. `source` and the external_* columns are reserved for calendar sync and are
// never accepted from the API, so a meeting can't be made to look like it came from Google.
const meetingCreate = z
  .object({ ...fields, workspace_id: z.number().int().nullable(), task_ids: z.array(z.number().int()).max(50) })
  .partial()
  .required({ title: true, starts_at: true });
const meetingUpdate = z.object(fields).partial();

const listQuery = z.object({
  workspace_id: z.coerce.number().int().optional(),
  task_id: z.coerce.number().int().optional(),
  from: iso.optional(),
  to: iso.optional(),
  when: z.enum(["upcoming", "past"]).optional(),
  sort: z.enum(["asc", "desc"]).default("asc"),
});

export function registerMeetings(app: Express, { db, auth, uid }: Deps) {
  /** Adds what the UI needs next to each meeting: linked tasks and what the caller may do. One query per kind, for the whole list. */
  async function present(q: Queryable, rows: MeetingRow[], userId: number) {
    if (rows.length === 0) return [];
    const [links, memberships] = await Promise.all([
      inChunks(rows.map((r) => r.id), (m, a) => q.all<{ meeting_id: number; task_id: number }>(`SELECT meeting_id, task_id FROM meeting_tasks WHERE meeting_id IN (${m}) ORDER BY task_id`, ...a)),
      q.all<{ workspace_id: number; role: Role }>("SELECT workspace_id, role FROM workspace_members WHERE user_id = ?", userId),
    ]);
    const roleOf = new Map(memberships.map((m) => [m.workspace_id, m.role]));
    return rows.map((r) => {
      const role = r.workspace_id === null ? null : (roleOf.get(r.workspace_id) ?? null);
      const access = r.workspace_id === null || atLeast(role, "admin") ? "admin" : atLeast(role, "member") ? "write" : "read";
      return {
        id: r.id,
        workspace_id: r.workspace_id,
        created_by: r.user_id,
        title: r.title,
        notes: r.notes as string,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        location: r.location as string,
        url: r.url as string,
        source: r.source as "local" | "google",
        external_url: (r.external_url as string | null) ?? null,
        created_at: r.created_at as string,
        task_ids: links.filter((l) => l.meeting_id === r.id).map((l) => l.task_id),
        access,
        can_delete: access === "admin" || (access === "write" && r.user_id === userId),
      };
    });
  }

  const one = async (q: Queryable, userId: number, meetingId: number) => {
    const a = await readableMeeting(q, userId, meetingId);
    return (await present(q, [a.row], userId))[0];
  };

  /** Every task being linked must be editable by the caller and live in the same place as the meeting. */
  const assertLinkable = async (q: Queryable, userId: number, meeting: { workspaceId: number | null }, taskIds: number[]) => {
    for (const id of new Set(taskIds)) {
      const ta = await taskAccess(q, userId, id);
      if (!ta || !ta.canWrite || ta.workspaceId !== meeting.workspaceId) {
        throw new HttpError(400, `Task ${id} can't be linked: it must exist, be editable by you, and be in the same workspace as the meeting`);
      }
    }
  };

  const link = async (q: Queryable, userId: number, meeting: MeetingRow, taskId: number) => {
    const info = await q.run("INSERT INTO meeting_tasks (meeting_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING", meeting.id, taskId);
    if (info.changes) {
      const task = (await q.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId))!;
      await logActivity(q, meeting.workspace_id, userId, "meeting_linked", taskId, { title: meeting.title, task_title: task.title });
    }
  };

  // ---------- list / read ----------
  app.get("/api/meetings", auth, async (req, res) => {
    const me = uid(req);
    const f = listQuery.parse(req.query);
    const where = [visibleMeetingsSql("m")];
    const args: unknown[] = [me, me];
    const add = (sql: string, ...a: unknown[]) => (where.push(sql), args.push(...a));
    if (f.workspace_id !== undefined) add("m.workspace_id = ?", f.workspace_id);
    if (f.task_id !== undefined) add("m.id IN (SELECT meeting_id FROM meeting_tasks WHERE task_id = ?)", f.task_id);
    if (f.from) add("m.starts_at >= ?", f.from);
    if (f.to) add("m.starts_at <= ?", f.to);
    if (f.when === "upcoming") add("m.ends_at >= ?", new Date().toISOString());
    if (f.when === "past") add("m.ends_at < ?", new Date().toISOString());
    const rows = await db.all<MeetingRow>(
      `SELECT m.* FROM meetings m WHERE ${where.join(" AND ")} ORDER BY m.starts_at ${f.sort === "desc" ? "DESC" : "ASC"}, m.id LIMIT ${MAX_LIST}`,
      ...args,
    );
    res.json(await present(db, rows, me));
  });

  app.get("/api/meetings/:id", auth, async (req, res) => {
    res.json(await one(db, uid(req), parseId(req.params.id, "Meeting not found")));
  });

  app.get("/api/tasks/:id/meetings", auth, async (req, res) => {
    const ta = await readableTask(db, uid(req), parseId(req.params.id, "Task not found"));
    const rows = await db.all<MeetingRow>(
      "SELECT m.* FROM meetings m JOIN meeting_tasks mt ON mt.meeting_id = m.id WHERE mt.task_id = ? ORDER BY m.starts_at, m.id",
      ta.row.id,
    );
    res.json(await present(db, rows, uid(req)));
  });

  // ---------- create / edit / delete ----------
  app.post("/api/meetings", auth, async (req, res) => {
    const me = uid(req);
    const b = meetingCreate.parse(req.body);
    const start = Date.parse(b.starts_at);
    const endsAt = b.ends_at ?? new Date(start + DEFAULT_LENGTH_MIN * 60_000).toISOString();
    if (Date.parse(endsAt) < start) throw new HttpError(400, "A meeting can't end before it starts");

    const workspaceId = b.workspace_id ?? null;
    if (workspaceId !== null) await requireRole(db, workspaceId, me, "member");
    await assertLinkable(db, me, { workspaceId }, b.task_ids ?? []);

    const id = await db.tx(async (t) => {
      const meetingId = await t.insert(
        "INSERT INTO meetings (user_id, workspace_id, title, notes, starts_at, ends_at, location, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        me, workspaceId, b.title, b.notes ?? "", b.starts_at, endsAt, b.location ?? "", b.url ?? "",
      );
      await logActivity(t, workspaceId, me, "meeting_created", null, { title: b.title });
      const row = (await t.get<MeetingRow>("SELECT * FROM meetings WHERE id = ?", meetingId))!;
      for (const taskId of new Set(b.task_ids ?? [])) await link(t, me, row, taskId);
      return meetingId;
    });
    res.status(201).json(await one(db, me, id));
  });

  app.patch("/api/meetings/:id", auth, async (req, res) => {
    const me = uid(req);
    const ma = await writableMeeting(db, me, parseId(req.params.id, "Meeting not found"));
    const b = meetingUpdate.parse(req.body);
    const starts = b.starts_at ?? ma.row.starts_at;
    let ends = b.ends_at ?? ma.row.ends_at;
    // Moving the start without saying when it ends shifts the end by the same amount, keeping the meeting's length.
    if (b.starts_at && !b.ends_at) ends = new Date(Date.parse(b.starts_at) + (Date.parse(ma.row.ends_at) - Date.parse(ma.row.starts_at))).toISOString();
    if (Date.parse(ends) < Date.parse(starts)) throw new HttpError(400, "A meeting can't end before it starts");

    const sets: string[] = [];
    const args: unknown[] = [];
    for (const key of ["title", "notes", "location", "url"] as const) {
      if (b[key] !== undefined) (sets.push(`${key} = ?`), args.push(b[key]));
    }
    if (b.starts_at !== undefined || b.ends_at !== undefined) (sets.push("starts_at = ?", "ends_at = ?"), args.push(starts, ends));
    if (sets.length) await db.run(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`, ...args, ma.row.id);
    res.json(await one(db, me, ma.row.id));
  });

  app.delete("/api/meetings/:id", auth, async (req, res) => {
    const me = uid(req);
    const ma = await readableMeeting(db, me, parseId(req.params.id, "Meeting not found"));
    if (!ma.canDelete) throw FORBIDDEN();
    await db.tx(async (t) => {
      await logActivity(t, ma.workspaceId, me, "meeting_deleted", null, { title: ma.row.title });
      await t.run("DELETE FROM meetings WHERE id = ?", ma.row.id); // links go with it; the tasks are untouched
    });
    res.status(204).end();
  });

  // ---------- linking ----------
  app.post("/api/meetings/:id/tasks", auth, async (req, res) => {
    const me = uid(req);
    const ma: MeetingAccess = await writableMeeting(db, me, parseId(req.params.id, "Meeting not found"));
    const { task_id } = z.object({ task_id: z.number().int() }).parse(req.body);
    await assertLinkable(db, me, ma, [task_id]);
    await db.tx((t) => link(t, me, ma.row, task_id));
    res.status(201).json(await one(db, me, ma.row.id));
  });

  app.delete("/api/meetings/:id/tasks/:taskId", auth, async (req, res) => {
    const me = uid(req);
    const ma = await writableMeeting(db, me, parseId(req.params.id, "Meeting not found"));
    const taskId = parseId(req.params.taskId, "Task not found");
    await db.tx(async (t) => {
      const info = await t.run("DELETE FROM meeting_tasks WHERE meeting_id = ? AND task_id = ?", ma.row.id, taskId);
      if (info.changes) {
        const task = await t.get<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId);
        await logActivity(t, ma.workspaceId, me, "meeting_unlinked", taskId, { title: ma.row.title, task_title: task?.title ?? "" });
      }
    });
    res.json(await one(db, me, ma.row.id));
  });
}
