import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { FORBIDDEN, atLeast, readableTask, requireRole, roleIn, writableTask, type Role } from "./access.js";
import type { DB } from "./db.js";
import { displayNameSql, logActivity, notify } from "./events.js";
import { HttpError } from "./http-error.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
const NAME = displayNameSql("u");

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Invalid id");
  return n;
};

export function registerCollab(app: Express, { db, auth, uid }: Deps) {
  const myEmail = (userId: number) => (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string }).email;
  const workspaceName = (wsId: number) => (db.prepare("SELECT name FROM workspaces WHERE id = ?").get(wsId) as { name: string }).name;

  // ---------- people ----------
  /** Me and everyone I share a workspace with: enough to render names and avatars. */
  app.get("/api/people", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT u.id, ${NAME} AS name, u.email FROM users u
           WHERE u.id = ? OR u.id IN (
             SELECT m2.user_id FROM workspace_members m1 JOIN workspace_members m2 ON m2.workspace_id = m1.workspace_id WHERE m1.user_id = ?)
           ORDER BY name`,
        )
        .all(uid(req), uid(req)),
    );
  });

  // ---------- workspaces ----------
  app.get("/api/workspaces", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT w.id, w.name, m.role,
                  (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
           FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? ORDER BY w.name`,
        )
        .all(uid(req)),
    );
  });

  app.post("/api/workspaces", auth, (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const wsId = db.transaction(() => {
      const info = db.prepare("INSERT INTO workspaces (name, created_by) VALUES (?, ?)").run(name, uid(req));
      const wsId = Number(info.lastInsertRowid);
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(wsId, uid(req));
      return wsId;
    })();
    res.status(201).json({ id: wsId, name, role: "owner", member_count: 1 });
  });

  app.get("/api/workspaces/:id", auth, (req, res) => {
    const wsId = id(req.params.id);
    const role = requireRole(db, wsId, uid(req), "viewer");
    const ws = db.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(wsId);
    const members = db
      .prepare(
        `SELECT u.id, ${NAME} AS name, u.email, m.role, m.joined_at FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, name`,
      )
      .all(wsId);
    const invites = atLeast(role, "admin")
      ? db
          .prepare(
            `SELECT i.id, i.email, i.role, i.created_at, ${NAME} AS invited_by FROM workspace_invites i JOIN users u ON u.id = i.invited_by
             WHERE i.workspace_id = ? ORDER BY i.id`,
          )
          .all(wsId)
      : [];
    res.json({ ...(ws as object), role, members, invites });
  });

  app.patch("/api/workspaces/:id", auth, (req, res) => {
    const wsId = id(req.params.id);
    requireRole(db, wsId, uid(req), "admin");
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const from = workspaceName(wsId);
    db.prepare("UPDATE workspaces SET name = ? WHERE id = ?").run(name, wsId);
    if (from !== name) logActivity(db, wsId, uid(req), "workspace_renamed", null, { from, to: name });
    res.json({ id: wsId, name });
  });

  app.delete("/api/workspaces/:id", auth, (req, res) => {
    const wsId = id(req.params.id);
    requireRole(db, wsId, uid(req), "owner");
    db.transaction(() => {
      db.prepare("DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(wsId);
      db.prepare("DELETE FROM projects WHERE workspace_id = ?").run(wsId);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(wsId); // members, invites, activity and alerts cascade
    })();
    res.status(204).end();
  });

  // ---------- invites ----------
  const inviteBody = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "member", "viewer"]).default("member") });

  app.post("/api/workspaces/:id/invites", auth, (req, res) => {
    const wsId = id(req.params.id);
    const role = requireRole(db, wsId, uid(req), "admin");
    const b = inviteBody.parse(req.body);
    if (b.role === "admin" && role !== "owner") throw FORBIDDEN();
    const existing = db
      .prepare("SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?")
      .get(wsId, b.email);
    if (existing) throw new HttpError(409, "That person is already a member");
    db.prepare(
      `INSERT INTO workspace_invites (workspace_id, email, role, invited_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by`,
    ).run(wsId, b.email, b.role, uid(req));
    // The response is identical whether or not the address has an account, so this can't be used to probe for users.
    res.status(201).json({ email: b.email, role: b.role });
  });

  app.delete("/api/workspaces/:id/invites/:inviteId", auth, (req, res) => {
    const wsId = id(req.params.id);
    requireRole(db, wsId, uid(req), "admin");
    const info = db.prepare("DELETE FROM workspace_invites WHERE id = ? AND workspace_id = ?").run(id(req.params.inviteId), wsId);
    if (!info.changes) throw new HttpError(404, "Invite not found");
    res.status(204).end();
  });

  /** Invitations addressed to my email. */
  app.get("/api/invites", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT i.id, i.role, i.created_at, w.id AS workspace_id, w.name AS workspace_name, ${NAME} AS invited_by
           FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
           WHERE i.email = ? ORDER BY i.id DESC`,
        )
        .all(myEmail(uid(req))),
    );
  });

  const myInvite = (userId: number, inviteId: number) => {
    const inv = db.prepare("SELECT id, workspace_id, role, invited_by FROM workspace_invites WHERE id = ? AND email = ?").get(inviteId, myEmail(userId)) as
      | { id: number; workspace_id: number; role: Role; invited_by: number }
      | undefined;
    if (!inv) throw new HttpError(404, "Invite not found");
    return inv;
  };

  app.post("/api/invites/:inviteId/accept", auth, (req, res) => {
    const me = uid(req);
    const inv = myInvite(me, id(req.params.inviteId));
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)").run(inv.workspace_id, me, inv.role);
      db.prepare("DELETE FROM workspace_invites WHERE id = ?").run(inv.id);
      logActivity(db, inv.workspace_id, me, "member_joined", null, { role: inv.role });
      notify(db, { userId: inv.invited_by, kind: "invite_accepted", actorId: me, workspaceId: inv.workspace_id, title: workspaceName(inv.workspace_id) });
    })();
    res.json({ workspace_id: inv.workspace_id, role: inv.role });
  });

  app.post("/api/invites/:inviteId/decline", auth, (req, res) => {
    const inv = myInvite(uid(req), id(req.params.inviteId));
    db.prepare("DELETE FROM workspace_invites WHERE id = ?").run(inv.id);
    res.status(204).end();
  });

  // ---------- members ----------
  app.patch("/api/workspaces/:id/members/:userId", auth, (req, res) => {
    const me = uid(req);
    const wsId = id(req.params.id);
    const target = id(req.params.userId);
    const myRole = requireRole(db, wsId, me, "admin");
    const { role } = z.object({ role: roleSchema }).parse(req.body);
    const current = roleIn(db, wsId, target);
    if (!current) throw new HttpError(404, "Member not found");
    if (target === me) throw new HttpError(400, "You can't change your own role");
    if (myRole !== "owner") {
      // Admins may only move people between member and viewer.
      if (!["member", "viewer"].includes(current) || !["member", "viewer"].includes(role)) throw FORBIDDEN();
    }
    if (role === current) return void res.json({ id: target, role });
    db.transaction(() => {
      if (role === "owner") {
        db.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?").run(wsId, me); // hand over
        logActivity(db, wsId, me, "role_changed", null, { user_id: me, from: "owner", to: "admin" });
      }
      db.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").run(role, wsId, target);
      logActivity(db, wsId, me, "role_changed", null, { user_id: target, from: current, to: role });
      // A viewer can't keep work assigned to them.
      if (role === "viewer") {
        db.prepare("UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)").run(target, wsId);
      }
    })();
    res.json({ id: target, role });
  });

  app.delete("/api/workspaces/:id/members/:userId", auth, (req, res) => {
    const me = uid(req);
    const wsId = id(req.params.id);
    const target = id(req.params.userId);
    const myRole = requireRole(db, wsId, me, "viewer");
    const targetRole = roleIn(db, wsId, target);
    if (!targetRole) throw new HttpError(404, "Member not found");

    if (target === me) {
      if (myRole === "owner") throw new HttpError(409, "Transfer ownership to someone else before leaving, or delete the workspace");
    } else {
      if (!atLeast(myRole, "admin")) throw FORBIDDEN();
      if (myRole !== "owner" && !["member", "viewer"].includes(targetRole)) throw FORBIDDEN();
    }
    const wsName = workspaceName(wsId);
    db.transaction(() => {
      logActivity(db, wsId, me, target === me ? "member_left" : "member_removed", null, { user_id: target });
      const inWs = "project_id IN (SELECT id FROM projects WHERE workspace_id = ?)";
      db.prepare(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ? AND ${inWs}`).run(target, wsId);
      db.prepare(`UPDATE time_entries SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL AND task_id IN (SELECT id FROM tasks WHERE ${inWs})`).run(new Date().toISOString(), target, wsId);
      db.prepare(`DELETE FROM gcal_links WHERE user_id = ? AND task_id IN (SELECT id FROM tasks WHERE ${inWs})`).run(target, wsId);
      db.prepare("DELETE FROM alerts WHERE user_id = ? AND workspace_id = ?").run(target, wsId);
      db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").run(wsId, target);
      if (target !== me) notify(db, { userId: target, kind: "removed", actorId: me, title: wsName });
    })();
    res.status(204).end();
  });

  // ---------- comments ----------
  const commentBody = z.object({ body: z.string().trim().min(1).max(5000), mentions: z.array(z.number().int()).max(20).optional() });

  const loadComments = (taskId: number) => {
    const rows = db
      .prepare(`SELECT c.id, c.user_id, c.body, c.created_at, c.edited_at FROM comments c WHERE c.task_id = ? ORDER BY c.id`)
      .all(taskId) as { id: number; user_id: number; body: string; created_at: string; edited_at: string | null }[];
    const mentionStmt = db.prepare(`SELECT u.id, ${NAME} AS name FROM comment_mentions cm JOIN users u ON u.id = cm.user_id WHERE cm.comment_id = ?`);
    return rows.map((r) => ({ ...r, mentions: mentionStmt.all(r.id) as { id: number; name: string }[] }));
  };

  /** Mentionable = people in the task's workspace (any role: a viewer can be pulled in to read), never the author. */
  const validMentions = (workspaceId: number | null, authorId: number, ids: number[] | undefined) =>
    workspaceId === null ? [] : [...new Set(ids ?? [])].filter((u) => u !== authorId && roleIn(db, workspaceId, u) !== null);

  app.get("/api/tasks/:id/comments", auth, (req, res) => {
    const ta = readableTask(db, uid(req), String(req.params.id));
    res.json(loadComments(ta.row.id));
  });

  app.post("/api/tasks/:id/comments", auth, (req, res) => {
    const me = uid(req);
    const ta = writableTask(db, me, String(req.params.id)); // viewers can read but not comment
    const b = commentBody.parse(req.body);
    const mentions = validMentions(ta.workspaceId, me, b.mentions);
    const title = ta.row.title;

    const commentId = db.transaction(() => {
      const info = db.prepare("INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)").run(ta.row.id, me, b.body);
      const cid = Number(info.lastInsertRowid);
      for (const u of mentions) {
        db.prepare("INSERT INTO comment_mentions (comment_id, user_id) VALUES (?, ?)").run(cid, u);
        notify(db, { userId: u, kind: "mentioned", actorId: me, taskId: ta.row.id, workspaceId: ta.workspaceId, title });
      }
      // Everyone with a stake in the task hears about it, once, unless they were already pinged by a mention.
      if (ta.workspaceId !== null) {
        for (const u of new Set([ta.row.user_id, ta.row.assignee_id].filter((x): x is number => x != null))) {
          if (!mentions.includes(u) && roleIn(db, ta.workspaceId, u))
            notify(db, { userId: u, kind: "commented", actorId: me, taskId: ta.row.id, workspaceId: ta.workspaceId, title });
        }
      }
      logActivity(db, ta.workspaceId, me, "comment_added", ta.row.id, { title });
      return cid;
    })();
    res.status(201).json(loadComments(ta.row.id).find((c) => c.id === commentId));
  });

  const commentAccess = (userId: number, commentId: number) => {
    const c = db.prepare("SELECT id, task_id, user_id FROM comments WHERE id = ?").get(commentId) as { id: number; task_id: number; user_id: number } | undefined;
    if (!c) throw new HttpError(404, "Comment not found");
    return { comment: c, task: readableTask(db, userId, c.task_id) }; // 404 when the task isn't visible
  };

  app.patch("/api/comments/:commentId", auth, (req, res) => {
    const me = uid(req);
    const { comment, task } = commentAccess(me, id(req.params.commentId));
    if (comment.user_id !== me) throw FORBIDDEN(); // only the author edits their words
    if (!task.canWrite) throw FORBIDDEN();
    const b = commentBody.parse(req.body);
    db.transaction(() => {
      db.prepare("UPDATE comments SET body = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b.body, comment.id);
      // People newly mentioned by the edit are told; people already mentioned aren't pinged again.
      for (const u of validMentions(task.workspaceId, me, b.mentions)) {
        const info = db.prepare("INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?, ?)").run(comment.id, u);
        if (info.changes) notify(db, { userId: u, kind: "mentioned", actorId: me, taskId: task.row.id, workspaceId: task.workspaceId, title: task.row.title });
      }
    })();
    res.json(loadComments(task.row.id).find((c) => c.id === comment.id));
  });

  app.delete("/api/comments/:commentId", auth, (req, res) => {
    const me = uid(req);
    const { comment, task } = commentAccess(me, id(req.params.commentId));
    if (comment.user_id !== me && !task.canManage) throw FORBIDDEN(); // author, or a workspace admin moderating
    db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
    res.status(204).end();
  });

  // ---------- activity ----------
  const parseActivity = (r: { id: number; kind: string; user_id: number; task_id: number | null; detail_json: string; created_at: string }) => {
    const { detail_json, ...rest } = r;
    return { ...rest, detail: JSON.parse(detail_json) as Record<string, unknown> };
  };

  const feedQuery = z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

  app.get("/api/workspaces/:id/activity", auth, (req, res) => {
    const wsId = id(req.params.id);
    requireRole(db, wsId, uid(req), "viewer");
    const q = feedQuery.parse(req.query);
    const rows = db
      .prepare("SELECT id, kind, user_id, task_id, detail_json, created_at FROM activity WHERE workspace_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
      .all(wsId, q.before ?? Number.MAX_SAFE_INTEGER, q.limit + 1) as Parameters<typeof parseActivity>[0][];
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(parseActivity);
    res.json({ items, next: more ? items[items.length - 1].id : null });
  });

  app.get("/api/tasks/:id/activity", auth, (req, res) => {
    const ta = readableTask(db, uid(req), String(req.params.id));
    const rows = db
      .prepare("SELECT id, kind, user_id, task_id, detail_json, created_at FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 50")
      .all(ta.row.id) as Parameters<typeof parseActivity>[0][];
    res.json(rows.map(parseActivity));
  });

  // ---------- alerts (things that happened to me) ----------
  app.get("/api/alerts", auth, (req, res) => {
    const me = uid(req);
    const items = db
      .prepare(
        `SELECT id, kind, actor_id, task_id, workspace_id, title, created_at, read_at IS NOT NULL AS read FROM alerts
         WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(me)
      .map((a) => ({ ...(a as object), read: !!(a as { read: number }).read }));
    const unread = (db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE user_id = ? AND read_at IS NULL").get(me) as { n: number }).n;
    const invites = (db.prepare("SELECT COUNT(*) AS n FROM workspace_invites WHERE email = ?").get(myEmail(me)) as { n: number }).n;
    res.json({ unread, invites, items });
  });

  app.post("/api/alerts/read", auth, (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(200).optional() }).parse(req.body ?? {});
    const now = new Date().toISOString();
    if (ids) {
      const stmt = db.prepare("UPDATE alerts SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL");
      for (const aid of ids) stmt.run(now, aid, uid(req));
    } else {
      db.prepare("UPDATE alerts SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, uid(req));
    }
    res.status(204).end();
  });

}
