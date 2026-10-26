import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { myArgs, myTasksSql, readableTask, taskAccess, writableTask } from "./access.js";
import type { DB, Queryable } from "./db.js";
import { epoch, localDay } from "./dialect.js";
import { HttpError, parseId } from "./http-error.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
  getTask: (userId: number, id: number) => Promise<unknown>;
}

/** Dependencies, checklists, saved filters, time tracking and stats. */
export function registerExtras(app: Express, { db, auth, uid, getTask }: Deps) {
  const D = db.dialect;
  /** The caller must be able to edit the task: 404 if they can't see it, 403 if it is read-only to them. */
  const owns = (userId: number, taskId: number) => writableTask(db, userId, taskId);

  // ---------- dependencies ----------
  app.post("/api/tasks/:id/deps", auth, async (req, res) => {
    const taskId = parseId(req.params.id, "Task not found");
    const { blocked_by_id } = z.object({ blocked_by_id: z.number().int() }).parse(req.body);
    const a = await owns(uid(req), taskId);
    // Both ends must be editable by the caller and live in the same place (same workspace, or both private).
    const b = await taskAccess(db, uid(req), blocked_by_id);
    if (!b || !b.canWrite || b.workspaceId !== a.workspaceId) throw new HttpError(400, "Invalid blocked_by_id");
    if (blocked_by_id === taskId) throw new HttpError(400, "A task cannot block itself");
    // Adding taskId -> blocked_by_id closes a cycle if blocked_by_id already (transitively) waits on taskId.
    const cycle = await db.get(
      `WITH RECURSIVE chain(id) AS (
         SELECT CAST(? AS INTEGER) UNION SELECT d.blocked_by_id FROM task_deps d JOIN chain c ON d.task_id = c.id)
       SELECT 1 FROM chain WHERE id = ?`,
      blocked_by_id,
      taskId,
    );
    if (cycle) throw new HttpError(400, "That dependency would create a cycle");
    await db.run("INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?, ?) ON CONFLICT DO NOTHING", taskId, blocked_by_id);
    res.status(201).json(await getTask(uid(req), taskId));
  });

  app.delete("/api/tasks/:id/deps/:blockedById", auth, async (req, res) => {
    const taskId = parseId(req.params.id, "Task not found");
    await owns(uid(req), taskId);
    await db.run("DELETE FROM task_deps WHERE task_id = ? AND blocked_by_id = ?", taskId, parseId(req.params.blockedById));
    res.json(await getTask(uid(req), taskId));
  });

  // ---------- checklists ----------
  const itemOwned = async (userId: number, itemId: number) => {
    const row = await db.get<{ task_id: number }>("SELECT task_id FROM checklist_items WHERE id = ?", itemId);
    if (!row || !(await taskAccess(db, userId, row.task_id))) throw new HttpError(404, "Checklist item not found");
    await owns(userId, row.task_id); // visible, but read-only people get 403
    return row.task_id;
  };

  app.get("/api/tasks/:id/checklist", auth, async (req, res) => {
    const taskId = parseId(req.params.id, "Task not found");
    await readableTask(db, uid(req), taskId);
    const rows = await db.all<{ id: number; text: string; done: number; position: number }>(
      "SELECT id, text, done, position FROM checklist_items WHERE task_id = ? ORDER BY position, id",
      taskId,
    );
    res.json(rows.map((r) => ({ ...r, done: !!r.done })));
  });

  app.post("/api/tasks/:id/checklist", auth, async (req, res) => {
    const taskId = parseId(req.params.id, "Task not found");
    const { text } = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
    await owns(uid(req), taskId);
    const itemId = await db.insert(
      `INSERT INTO checklist_items (task_id, text, position)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM checklist_items WHERE task_id = ?))`,
      taskId, text, taskId,
    );
    res.status(201).json({ id: itemId, text, done: false });
  });

  app.patch("/api/checklist/:itemId", auth, async (req, res) => {
    const itemId = parseId(req.params.itemId, "Checklist item not found");
    const b = z.object({ text: z.string().min(1).max(500), done: z.boolean() }).partial().parse(req.body);
    await itemOwned(uid(req), itemId);
    await db.run(
      "UPDATE checklist_items SET text = COALESCE(?, text), done = COALESCE(?, done) WHERE id = ?",
      b.text ?? null,
      b.done === undefined ? null : Number(b.done),
      itemId,
    );
    const row = (await db.get<{ id: number; text: string; done: number }>("SELECT id, text, done FROM checklist_items WHERE id = ?", itemId))!;
    res.json({ ...row, done: !!row.done });
  });

  app.delete("/api/checklist/:itemId", auth, async (req, res) => {
    const itemId = parseId(req.params.itemId, "Checklist item not found");
    await itemOwned(uid(req), itemId);
    await db.run("DELETE FROM checklist_items WHERE id = ?", itemId);
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

  app.get("/api/filters", auth, async (req, res) => {
    const rows = await db.all<{ id: number; name: string; query_json: string }>("SELECT id, name, query_json FROM saved_filters WHERE user_id = ? ORDER BY name, id", uid(req));
    res.json(rows.map(filterOut));
  });
  app.post("/api/filters", auth, async (req, res) => {
    const b = filterBody.parse(req.body);
    const filterId = await db.insert("INSERT INTO saved_filters (user_id, name, query_json) VALUES (?, ?, ?)", uid(req), b.name, JSON.stringify(b.query));
    res.status(201).json({ id: filterId, name: b.name, query: b.query });
  });
  app.delete("/api/filters/:id", auth, async (req, res) => {
    const info = await db.run("DELETE FROM saved_filters WHERE id = ? AND user_id = ?", parseId(req.params.id, "Filter not found"), uid(req));
    if (!info.changes) throw new HttpError(404, "Filter not found");
    res.status(204).end();
  });

  // ---------- time tracking ----------
  const stopRunning = (q: Queryable, userId: number, now: string) =>
    q.run("UPDATE time_entries SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL", now, userId);

  app.post("/api/tasks/:id/timer/start", auth, async (req, res) => {
    const taskId = parseId(req.params.id, "Task not found");
    await owns(uid(req), taskId);
    const now = new Date().toISOString();
    await db.tx(async (t) => {
      await stopRunning(t, uid(req), now); // one running timer per user
      await t.run("INSERT INTO time_entries (task_id, user_id, started_at) VALUES (?, ?, ?)", taskId, uid(req), now);
    });
    res.status(201).json(await getTask(uid(req), taskId));
  });

  app.post("/api/timer/stop", auth, async (req, res) => {
    const running = await db.get<{ task_id: number }>("SELECT task_id FROM time_entries WHERE user_id = ? AND ended_at IS NULL", uid(req));
    await stopRunning(db, uid(req), new Date().toISOString());
    res.json(running ? await getTask(uid(req), running.task_id) : null);
  });

  app.get("/api/timer", auth, async (req, res) => {
    res.json(
      (await db.get(
        `SELECT e.task_id, e.started_at, t.title FROM time_entries e JOIN tasks t ON t.id = e.task_id
         WHERE e.user_id = ? AND e.ended_at IS NULL`,
        uid(req),
      )) ?? null,
    );
  });

  // ---------- stats ----------
  app.get("/api/stats", auth, async (req, res) => {
    // `offset` = the client's UTC offset in minutes, so "per day" buckets follow the user's calendar.
    const offset = z.coerce.number().int().min(-840).max(840).default(0).parse(req.query.offset);
    const user = uid(req);
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

    const rows = await db.all<{ day: string; count: number }>(
      `SELECT ${localDay(D, "t.completed_at")} AS day, COUNT(*) AS count FROM tasks t
       WHERE ${myTasksSql("t")} AND t.status = 'done' AND t.completed_at >= ? GROUP BY day`,
      offset, ...myArgs(user), daysAgo(14),
    );
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    const completed_by_day = Array.from({ length: 14 }, (_, i) => {
      const day = new Date(now.getTime() + offset * 60_000 - (13 - i) * 86_400_000).toISOString().slice(0, 10);
      return { day, count: byDay.get(day) ?? 0 };
    });

    const one = async (where: string, ...a: unknown[]) =>
      (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t WHERE ${myTasksSql("t")} AND ${where}`, ...myArgs(user), ...a))!.n;
    const open_total = await one("t.status != 'done'");
    const overdue = await one("t.status != 'done' AND t.due_at IS NOT NULL AND t.due_at < ?", now.toISOString());
    const completed_week = await one("t.status = 'done' AND t.completed_at >= ?", daysAgo(7));

    const time_by_project = await db.all(
      `SELECT p.id AS project_id, COALESCE(p.name, 'No project') AS name,
              ROUND(SUM(${epoch(D, "COALESCE(e.ended_at, ?)")} - ${epoch(D, "e.started_at")}) / 60.0) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE e.user_id = ? AND e.started_at >= ? GROUP BY p.id, p.name ORDER BY minutes DESC`,
      now.toISOString(), user, daysAgo(7),
    );

    res.json({ completed_by_day, open_total, overdue, completed_week, time_by_project });
  });
}
