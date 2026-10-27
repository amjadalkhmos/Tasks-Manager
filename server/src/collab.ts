import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { FORBIDDEN, atLeast, readableTask, requireRole, roleIn, writableTask, type Role } from "./access.js";
import type { DB } from "./db.js";
import { displayName } from "./dialect.js";
import { logActivity, notify } from "./events.js";
import { HttpError, parseId } from "./http-error.js";
import { releaseSalesRecords } from "./sales-setup.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);

/** Larger than any id we will hand out, small enough for a 32-bit integer column on every database. */
const NO_UPPER_LIMIT = 2_000_000_000;

export function registerCollab(app: Express, { db, auth, uid }: Deps) {
  const NAME = displayName(db.dialect, "u");
  const id = (v: unknown) => parseId(v, "Not found");

  const myEmail = async (userId: number) => (await db.get<{ email: string }>("SELECT email FROM users WHERE id = ?", userId))!.email;
  const workspaceName = async (wsId: number) => (await db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", wsId))!.name;

  // ---------- people ----------
  /** Me and everyone I share a workspace with: enough to render names and avatars. */
  app.get("/api/people", auth, async (req, res) => {
    res.json(
      await db.all(
        `SELECT u.id, ${NAME} AS name, u.email FROM users u
         WHERE u.id = ? OR u.id IN (
           SELECT m2.user_id FROM workspace_members m1 JOIN workspace_members m2 ON m2.workspace_id = m1.workspace_id WHERE m1.user_id = ?)
         ORDER BY name, u.id`,
        uid(req),
        uid(req),
      ),
    );
  });

  // ---------- workspaces ----------
  app.get("/api/workspaces", auth, async (req, res) => {
    res.json(
      await db.all(
        `SELECT w.id, w.name, m.role,
                (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? ORDER BY w.name, w.id`,
        uid(req),
      ),
    );
  });

  app.post("/api/workspaces", auth, async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const wsId = await db.tx(async (t) => {
      const created = await t.insert("INSERT INTO workspaces (name, created_by) VALUES (?, ?)", name, uid(req));
      await t.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')", created, uid(req));
      return created;
    });
    res.status(201).json({ id: wsId, name, role: "owner", member_count: 1 });
  });

  app.get("/api/workspaces/:id", auth, async (req, res) => {
    const wsId = id(req.params.id);
    const role = await requireRole(db, wsId, uid(req), "viewer");
    const ws = await db.get("SELECT id, name FROM workspaces WHERE id = ?", wsId);
    const members = await db.all(
      `SELECT u.id, ${NAME} AS name, u.email, m.role, m.joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, name, u.id`,
      wsId,
    );
    const invites = atLeast(role, "admin")
      ? await db.all(
          `SELECT i.id, i.email, i.role, i.created_at, ${NAME} AS invited_by FROM workspace_invites i JOIN users u ON u.id = i.invited_by
           WHERE i.workspace_id = ? ORDER BY i.id`,
          wsId,
        )
      : [];
    res.json({ ...(ws as object), role, members, invites });
  });

  app.patch("/api/workspaces/:id", auth, async (req, res) => {
    const wsId = id(req.params.id);
    await requireRole(db, wsId, uid(req), "admin");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const from = await workspaceName(wsId);
    await db.run("UPDATE workspaces SET name = ? WHERE id = ?", name, wsId);
    if (from !== name) await logActivity(db, wsId, uid(req), "workspace_renamed", null, { from, to: name });
    res.json({ id: wsId, name });
  });

  app.delete("/api/workspaces/:id", auth, async (req, res) => {
    const wsId = id(req.params.id);
    await requireRole(db, wsId, uid(req), "owner");
    await db.tx(async (t) => {
      await t.run("DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)", wsId);
      await t.run("DELETE FROM projects WHERE workspace_id = ?", wsId);
      await t.run("DELETE FROM workspaces WHERE id = ?", wsId); // members, invites, activity and alerts cascade
    });
    res.status(204).end();
  });

  // ---------- invites ----------
  const inviteBody = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "member", "viewer"]).default("member") });

  app.post("/api/workspaces/:id/invites", auth, async (req, res) => {
    const wsId = id(req.params.id);
    const role = await requireRole(db, wsId, uid(req), "admin");
    const b = inviteBody.parse(req.body);
    if (b.role === "admin" && role !== "owner") throw FORBIDDEN();
    const existing = await db.get("SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?", wsId, b.email);
    if (existing) throw new HttpError(409, "That person is already a member");
    await db.run(
      `INSERT INTO workspace_invites (workspace_id, email, role, invited_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`,
      wsId, b.email, b.role, uid(req),
    );
    // The response is identical whether or not the address has an account, so this can't be used to probe for users.
    res.status(201).json({ email: b.email, role: b.role });
  });

  app.delete("/api/workspaces/:id/invites/:inviteId", auth, async (req, res) => {
    const wsId = id(req.params.id);
    await requireRole(db, wsId, uid(req), "admin");
    const info = await db.run("DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ?", id(req.params.inviteId), wsId);
    if (!info.changes) throw new HttpError(404, "Invite not found");
    res.status(204).end();
  });

  /** Invitations addressed to my email. */
  app.get("/api/invites", auth, async (req, res) => {
    res.json(
      await db.all(
        `SELECT i.id, i.role, i.created_at, w.id AS workspace_id, w.name AS workspace_name, ${NAME} AS invited_by
         FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
         WHERE i.email = ? ORDER BY i.id DESC`,
        await myEmail(uid(req)),
      ),
    );
  });

  const myInvite = async (userId: number, inviteId: number) => {
    const inv = await db.get<{ id: number; workspace_id: number; role: Role; invited_by: number }>(
      "SELECT id, workspace_id, role, invited_by FROM workspace_invites WHERE id = ? AND email = ?",
      inviteId,
      await myEmail(userId),
    );
    if (!inv) throw new HttpError(404, "Invite not found");
    return inv;
  };

  app.post("/api/invites/:inviteId/accept", auth, async (req, res) => {
    const me = uid(req);
    const inv = await myInvite(me, id(req.params.inviteId));
    const name = await workspaceName(inv.workspace_id);
    await db.tx(async (t) => {
      await t.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", inv.workspace_id, me, inv.role);
      await t.run("DELETE FROM workspace_invites WHERE id = ?", inv.id);
      await logActivity(t, inv.workspace_id, me, "member_joined", null, { role: inv.role });
      await notify(t, { userId: inv.invited_by, kind: "invite_accepted", actorId: me, workspaceId: inv.workspace_id, title: name });
    });
    res.json({ workspace_id: inv.workspace_id, role: inv.role });
  });

  app.post("/api/invites/:inviteId/decline", auth, async (req, res) => {
    const inv = await myInvite(uid(req), id(req.params.inviteId));
    await db.run("DELETE FROM workspace_invites WHERE id = ?", inv.id);
    res.status(204).end();
  });

  // ---------- members ----------
  app.patch("/api/workspaces/:id/members/:userId", auth, async (req, res) => {
    const me = uid(req);
    const wsId = id(req.params.id);
    const target = id(req.params.userId);
    const myRole = await requireRole(db, wsId, me, "admin");
    const { role } = z.object({ role: roleSchema }).parse(req.body);
    const current = await roleIn(db, wsId, target);
    if (!current) throw new HttpError(404, "Member not found");
    if (target === me) throw new HttpError(400, "You can't change your own role");
    if (myRole !== "owner") {
      // Admins may only move people between member and viewer.
      if (!["member", "viewer"].includes(current) || !["member", "viewer"].includes(role)) throw FORBIDDEN();
    }
    if (role === current) return void res.json({ id: target, role });
    await db.tx(async (t) => {
      if (role === "owner") {
        await t.run("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?", wsId, me); // hand over
        await logActivity(t, wsId, me, "role_changed", null, { user_id: me, from: "owner", to: "admin" });
      }
      await t.run("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?", role, wsId, target);
      await logActivity(t, wsId, me, "role_changed", null, { user_id: target, from: current, to: role });
      // A viewer can't keep work assigned to them.
      if (role === "viewer") {
        await t.run("UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)", target, wsId);
      }
    });
    res.json({ id: target, role });
  });

  app.delete("/api/workspaces/:id/members/:userId", auth, async (req, res) => {
    const me = uid(req);
    const wsId = id(req.params.id);
    const target = id(req.params.userId);
    const myRole = await requireRole(db, wsId, me, "viewer");
    const targetRole = await roleIn(db, wsId, target);
    if (!targetRole) throw new HttpError(404, "Member not found");

    if (target === me) {
      if (myRole === "owner") throw new HttpError(409, "Transfer ownership to someone else before leaving, or delete the workspace");
    } else {
      if (!atLeast(myRole, "admin")) throw FORBIDDEN();
      if (myRole !== "owner" && !["member", "viewer"].includes(targetRole)) throw FORBIDDEN();
    }
    const wsName = await workspaceName(wsId);
    await db.tx(async (t) => {
      await logActivity(t, wsId, me, target === me ? "member_left" : "member_removed", null, { user_id: target });
      const inWs = "project_id IN (SELECT id FROM projects WHERE workspace_id = ?)";
      await t.run(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ? AND ${inWs}`, target, wsId);
      await t.run(`UPDATE time_entries SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE ${inWs})`, new Date().toISOString(), target, wsId);
      await t.run(`DELETE FROM gcal_links WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE ${inWs})`, target, wsId);
      await t.run("DELETE FROM alerts WHERE user_id = ? AND workspace_id = ?", target, wsId);
      await releaseSalesRecords(t, wsId, target);
      await t.run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", wsId, target);
      if (target !== me) await notify(t, { userId: target, kind: "removed", actorId: me, title: wsName });
    });
    res.status(204).end();
  });

  // ---------- comments ----------
  const commentBody = z.object({ body: z.string().trim().min(1).max(5000), mentions: z.array(z.number().int()).max(20).optional() });

  const loadComments = async (taskId: number) => {
    const rows = await db.all<{ id: number; user_id: number; body: string; created_at: string; edited_at: string | null; requester: string | null }>(
      "SELECT id, user_id, body, created_at, edited_at, requester FROM comments WHERE task_id = ? ORDER BY id",
      taskId,
    );
    if (rows.length === 0) return [];
    const marks = rows.map(() => "?").join(",");
    const mentions = await db.all<{ comment_id: number; id: number; name: string }>(
      `SELECT cm.comment_id, u.id, ${NAME} AS name FROM comment_mentions cm JOIN users u ON u.id = cm.user_id WHERE cm.comment_id IN (${marks}) ORDER BY u.id`,
      ...rows.map((r) => r.id),
    );
    return rows.map((r) => ({ ...r, mentions: mentions.filter((m) => m.comment_id === r.id).map(({ id: uidd, name }) => ({ id: uidd, name })) }));
  };

  /** Mentionable = people in the task's workspace (any role: a viewer can be pulled in to read), never the author. */
  const validMentions = async (workspaceId: number | null, authorId: number, ids: number[] | undefined) => {
    if (workspaceId === null) return [];
    const out: number[] = [];
    for (const u of new Set(ids ?? [])) if (u !== authorId && (await roleIn(db, workspaceId, u)) !== null) out.push(u);
    return out;
  };

  app.get("/api/tasks/:id/comments", auth, async (req, res) => {
    const ta = await readableTask(db, uid(req), id(req.params.id));
    res.json(await loadComments(ta.row.id));
  });

  app.post("/api/tasks/:id/comments", auth, async (req, res) => {
    const me = uid(req);
    const ta = await writableTask(db, me, id(req.params.id)); // viewers can read but not comment
    const b = commentBody.parse(req.body);
    const mentions = await validMentions(ta.workspaceId, me, b.mentions);
    const title = ta.row.title;

    const commentId = await db.tx(async (t) => {
      const cid = await t.insert("INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)", ta.row.id, me, b.body);
      for (const u of mentions) {
        await t.run("INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)", cid, u);
        await notify(t, { userId: u, kind: "mentioned", actorId: me, taskId: ta.row.id, workspaceId: ta.workspaceId, title });
      }
      // Everyone with a stake in the task hears about it, once, unless they were already pinged by a mention.
      if (ta.workspaceId !== null) {
        for (const u of new Set([ta.row.user_id, ta.row.assignee_id].filter((x): x is number => x != null))) {
          if (!mentions.includes(u) && (await roleIn(t, ta.workspaceId, u)))
            await notify(t, { userId: u, kind: "commented", actorId: me, taskId: ta.row.id, workspaceId: ta.workspaceId, title });
        }
      }
      await logActivity(t, ta.workspaceId, me, "comment_added", ta.row.id, { title });
      return cid;
    });
    res.status(201).json((await loadComments(ta.row.id)).find((c) => c.id === commentId));
  });

  const commentAccess = async (userId: number, commentId: number) => {
    const c = await db.get<{ id: number; task_id: number; user_id: number }>("SELECT id, task_id, user_id FROM comments WHERE id = ?", commentId);
    if (!c) throw new HttpError(404, "Comment not found");
    return { comment: c, task: await readableTask(db, userId, c.task_id) }; // 404 when the task isn't visible
  };

  app.patch("/api/comments/:commentId", auth, async (req, res) => {
    const me = uid(req);
    const { comment, task } = await commentAccess(me, id(req.params.commentId));
    if (comment.user_id !== me) throw FORBIDDEN(); // only the author edits their words
    if (!task.canWrite) throw FORBIDDEN();
    const b = commentBody.parse(req.body);
    const mentions = await validMentions(task.workspaceId, me, b.mentions);
    await db.tx(async (t) => {
      await t.run("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", b.body, new Date().toISOString(), comment.id);
      // People newly mentioned by the edit are told; people already mentioned aren't pinged again.
      for (const u of mentions) {
        const info = await t.run("INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", comment.id, u);
        if (info.changes) await notify(t, { userId: u, kind: "mentioned", actorId: me, taskId: task.row.id, workspaceId: task.workspaceId, title: task.row.title });
      }
    });
    res.json((await loadComments(task.row.id)).find((c) => c.id === comment.id));
  });

  app.delete("/api/comments/:commentId", auth, async (req, res) => {
    const me = uid(req);
    const { comment, task } = await commentAccess(me, id(req.params.commentId));
    if (comment.user_id !== me && !task.canManage) throw FORBIDDEN(); // author, or a workspace admin moderating
    await db.run("DELETE FROM comments WHERE id = ?", comment.id);
    res.status(204).end();
  });

  // ---------- activity ----------
  type ActivityRow = { id: number; kind: string; user_id: number; task_id: number | null; detail_json: string; created_at: string };
  const parseActivity = (r: ActivityRow) => {
    const { detail_json, ...rest } = r;
    return { ...rest, detail: JSON.parse(detail_json) as Record<string, unknown> };
  };

  const feedQuery = z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

  app.get("/api/workspaces/:id/activity", auth, async (req, res) => {
    const wsId = id(req.params.id);
    await requireRole(db, wsId, uid(req), "viewer");
    const q = feedQuery.parse(req.query);
    const rows = await db.all<ActivityRow>(
      "SELECT id, kind, user_id, task_id, detail_json, created_at FROM activity WHERE workspace_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
      wsId,
      Math.min(q.before ?? NO_UPPER_LIMIT, NO_UPPER_LIMIT),
      q.limit + 1,
    );
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(parseActivity);
    res.json({ items, next: more ? items[items.length - 1].id : null });
  });

  app.get("/api/tasks/:id/activity", auth, async (req, res) => {
    const ta = await readableTask(db, uid(req), id(req.params.id));
    const rows = await db.all<ActivityRow>("SELECT id, kind, user_id, task_id, detail_json, created_at FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 50", ta.row.id);
    res.json(rows.map(parseActivity));
  });

  // ---------- alerts (things that happened to me) ----------
  app.get("/api/alerts", auth, async (req, res) => {
    const me = uid(req);
    const items = (
      await db.all<{ id: number; kind: string; actor_id: number | null; task_id: number | null; workspace_id: number | null; title: string; created_at: string; read: unknown }>(
        `SELECT id, kind, actor_id, task_id, workspace_id, title, created_at, (read_at IS NOT NULL) AS read FROM alerts
         WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
        me,
      )
    ).map((a) => ({ ...a, read: !!a.read }));
    const unread = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND read_at IS NULL", me))!.n;
    const invites = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_invites WHERE email = ?", await myEmail(me)))!.n;
    res.json({ unread, invites, items });
  });

  app.post("/api/alerts/read", auth, async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(200).optional() }).parse(req.body ?? {});
    const now = new Date().toISOString();
    if (ids) {
      for (const aid of ids) await db.run("UPDATE alerts SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL", now, aid, uid(req));
    } else {
      await db.run("UPDATE alerts SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, uid(req));
    }
    res.status(204).end();
  });
}
