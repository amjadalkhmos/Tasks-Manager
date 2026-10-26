import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { myArgs, myTasksSql, readableTask, taskAccess, writableTask } from "./access.js";
import type { DB } from "./db.js";
import { HttpError } from "./http-error.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
  getTask: (userId: number, id: number | string) => unknown;
}

const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, "Invalid id");
  return n;
};

/** Phase 2 routes: dependencies, checklists, saved filters, time tracking and stats. */
export function registerExtras(app: Express, { db, auth, uid, getTask }: Deps) {
  /** The caller must be able to edit the task: 404 if they can't see it, 403 if it is read-only to them. */
  const owns = (userId: number, taskId: number) => writableTask(db, userId, taskId);

  // ---------- dependencies ----------
  app.post("/api/tasks/:id/deps", auth, (req, res) => {
    const taskId = id(req.params.id);
    const { blocked_by_id } = z.object({ blocked_by_id: z.number().int() }).parse(req.body);
    const a = owns(uid(req), taskId);
    // Both ends must be editable by the caller and live in the same place (same workspace, or both private).
    const b = taskAccess(db, uid(req), blocked_by_id);
    if (!b || !b.canWrite || b.workspaceId !== a.workspaceId) throw new HttpError(400, "Invalid blocked_by_id");
    if (blocked_by_id === taskId) throw new HttpError(400, "A task cannot block itself");
    // Adding taskId -> blocked_by_id closes a cycle if blocked_by_id already (transitively) waits on taskId.
    const cycle = db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           SELECT ? UNION SELECT d.blocked_by_id FROM task_deps d JOIN chain c ON d.task_id = c.id)
         SELECT 1 FROM chain WHERE id = ?`,
      )
      .get(blocked_by_id, taskId);
    if (cycle) throw new HttpError(400, "That dependency would create a cycle");
    db.prepare("INSERT OR IGNORE INTO task_deps (task_id, blocked_by_id) VALUES (?, ?)").run(taskId, blocked_by_id);
    res.status(201).json(getTask(uid(req), taskId));
  });

  app.delete("/api/tasks/:id/deps/:blockedById", auth, (req, res) => {
    const taskId = id(req.params.id);
    owns(uid(req), taskId);
    db.prepare("DELETE FROM task_deps WHERE task_id = ? AND blocked_by_id = ?").run(taskId, id(req.params.blockedById));
    res.json(getTask(uid(req), taskId));
  });

  // ---------- checklists ----------
  const itemOwned = (userId: number, itemId: number) => {
    const row = db.prepare("SELECT task_id FROM checklist_items WHERE id = ?").get(itemId) as { task_id: number } | undefined;
    if (!row || !taskAccess(db, userId, row.task_id)) throw new HttpError(404, "Checklist item not found");
    owns(userId, row.task_id); // visible, but read-only people get 403
    return row.task_id;
  };

  app.get("/api/tasks/:id/checklist", auth, (req, res) => {
    const taskId = id(req.params.id);
    readableTask(db, uid(req), taskId);
    res.json(
      db
        .prepare("SELECT id, text, done, position FROM checklist_items WHERE task_id = ? ORDER BY position, id")
        .all(taskId)
        .map((r) => ({ ...(r as object), done: !!(r as { done: number }).done })),
    );
  });

  app.post("/api/tasks/:id/checklist", auth, (req, res) => {
    const taskId = id(req.params.id);
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    owns(uid(req), taskId);
    const info = db
      .prepare(
        `INSERT INTO checklist_items (task_id, text, position)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM checklist_items WHERE task_id = ?))`,
      )
      .run(taskId, text, taskId);
    res.status(201).json({ id: Number(info.lastInsertRowid), text, done: false });
  });

  app.patch("/api/checklist/:itemId", auth, (req, res) => {
    const itemId = id(req.params.itemId);
    const b = z.object({ text: z.string().min(1).max(500), done: z.boolean() }).partial().parse(req.body);
    itemOwned(uid(req), itemId);
    db.prepare("UPDATE checklist_items SET text = COALESCE(?, text), done = COALESCE(?, done) WHERE id = ?").run(
      b.text ?? null,
      b.done === undefined ? null : Number(b.done),
      itemId,
    );
    const row = db.prepare("SELECT id, text, done FROM checklist_items WHERE id = ?").get(itemId) as { done: number };
    res.json({ ...row, done: !!row.done });
  });

  app.delete("/api/checklist/:itemId", auth, (req, res) => {
    const itemId = id(req.params.itemId);
    itemOwned(uid(req), itemId);
    db.prepare("DELETE FROM checklist_items WHERE id = ?").run(itemId);
    res.status(204).end();
  });

  // ---------- saved filters ----------
  const filterBody = z.object({
    name: z.string().min(1).max(100),
    query: z.record(z.string(), z.union([z.string(), z.number()])),
  });
  const filterOut = (r: { id: number; name: string; query_json: string }) => ({
    id: r.id,
    name: r.name,
    query: JSON.parse(r.query_json) as Record<string, string | number>,
  });

  app.get("/api/filters", auth, (req, res) => {
    const rows = db.prepare("SELECT id, name, query_json FROM saved_filters WHERE user_id = ? ORDER BY name").all(uid(req));
    res.json((rows as Parameters<typeof filterOut>[0][]).map(filterOut));
  });
  app.post("/api/filters", auth, (req, res) => {
    const b = filterBody.parse(req.body);
    const info = db
      .prepare("INSERT INTO saved_filters (user_id, name, query_json) VALUES (?, ?, ?)")
      .run(uid(req), b.name, JSON.stringify(b.query));
    res.status(201).json({ id: Number(info.lastInsertRowid), name: b.name, query: b.query });
  });
  app.delete("/api/filters/:id", auth, (req, res) => {
    const info = db.prepare("DELETE FROM saved_filters WHERE id = ? AND user_id = ?").run(id(req.params.id), uid(req));
    if (!info.changes) throw new HttpError(404, "Filter not found");
    res.status(204).end();
  });

  // ---------- time tracking ----------
  const stopRunning = (userId: number, now: string) =>
    db.prepare("UPDATE time_entries SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL").run(now, userId);

  app.post("/api/tasks/:id/timer/start", auth, (req, res) => {
    const taskId = id(req.params.id);
    owns(uid(req), taskId);
    const now = new Date().toISOString();
    db.transaction(() => {
      stopRunning(uid(req), now); // one running timer per user
      db.prepare("INSERT INTO time_entries (task_id, user_id, started_at) VALUES (?, ?, ?)").run(taskId, uid(req), now);
    })();
    res.status(201).json(getTask(uid(req), taskId));
  });

  app.post("/api/timer/stop", auth, (req, res) => {
    const running = db
      .prepare("SELECT task_id FROM time_entries WHERE user_id = ? AND ended_at IS NULL")
      .get(uid(req)) as { task_id: number } | undefined;
    stopRunning(uid(req), new Date().toISOString());
    res.json(running ? getTask(uid(req), running.task_id) : null);
  });

  app.get("/api/timer", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT e.task_id, e.started_at, t.title FROM time_entries e JOIN tasks t ON t.id = e.task_id
           WHERE e.user_id = ? AND e.ended_at IS NULL`,
        )
        .get(uid(req)) ?? null,
    );
  });

  // ---------- stats ----------
  app.get("/api/stats", auth, (req, res) => {
    // `offset` = the client's UTC offset in minutes, so "per day" buckets follow the user's calendar.
    const offset = z.coerce.number().int().min(-840).max(840).default(0).parse(req.query.offset);
    const shift = `${offset >= 0 ? "+" : ""}${offset} minutes`;
    const user = uid(req);
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

    const rows = db
      .prepare(
        `SELECT date(t.completed_at, ?) AS day, COUNT(*) AS count FROM tasks t
         WHERE ${myTasksSql("t")} AND t.status = 'done' AND t.completed_at >= ? GROUP BY day`,
      )
      .all(shift, ...myArgs(user), daysAgo(14)) as { day: string; count: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const completed_by_day = Array.from({ length: 14 }, (_, i) => {
      const day = new Date(now.getTime() + offset * 60_000 - (13 - i) * 86_400_000).toISOString().slice(0, 10);
      return { day, count: byDay.get(day) ?? 0 };
    });

    const one = (where: string, ...a: unknown[]) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${myTasksSql("t")} AND ${where}`).get(...myArgs(user), ...a) as { n: number }).n;
    const open_total = one("t.status != 'done'");
    const overdue = one("t.status != 'done' AND t.due_at IS NOT NULL AND t.due_at < ?", now.toISOString());
    const completed_week = one("t.status = 'done' AND t.completed_at >= ?", daysAgo(7));

    const time_by_project = db
      .prepare(
        `SELECT p.id AS project_id, COALESCE(p.name, 'No project') AS name,
                ROUND(SUM(strftime('%s', COALESCE(e.ended_at, ?)) - strftime('%s', e.started_at)) / 60.0) AS minutes
         FROM time_entries e JOIN tasks t ON t.id = e.task_id LEFT JOIN projects p ON p.id = t.project_id
         WHERE e.user_id = ? AND e.started_at >= ? GROUP BY p.id ORDER BY minutes DESC`,
      )
      .all(now.toISOString(), user, daysAgo(7));

    res.json({ completed_by_day, open_total, overdue, completed_week, time_by_project });
  });
}
