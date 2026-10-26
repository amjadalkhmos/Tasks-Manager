import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import {
  FORBIDDEN, isMemberAtLeast, projectAccess, readableTask, roleIn, taskAccess, visibleArgs, visibleTasksSql, writableTask, atLeast,
  type TaskAccess, type TaskRow,
} from "./access.js";
import type { DB } from "./db.js";
import { logActivity, notify, userName } from "./events.js";
import { HttpError } from "./http-error.js";
import { nextOccurrence, parseRule, recurrenceSchema } from "./recurrence.js";

const iso = z.string().datetime({ offset: true });

const taskFields = {
  title: z.string().min(1).max(500),
  notes: z.string().max(10000),
  project_id: z.number().int().nullable(),
  parent_id: z.number().int().nullable(),
  assignee_id: z.number().int().nullable(),
  priority: z.number().int().min(0).max(3),
  status: z.enum(["todo", "doing", "done"]),
  due_at: iso.nullable(),
  remind_at: iso.nullable(),
  recurrence: recurrenceSchema.nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20),
  position: z.number().finite(),
  estimate_min: z.number().int().min(0).max(100000).nullable(),
};
const taskCreate = z.object(taskFields).partial().required({ title: true });
const taskUpdate = z.object(taskFields).partial();

const projectBody = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  workspace_id: z.number().int().nullable(),
});
const PROJECT_COLS = "id, name, color, workspace_id";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

export function registerTasks(app: Express, { db, auth, uid }: Deps) {
  // ---------- hydration ----------
  const tagStmt = db.prepare("SELECT t.name FROM tags t JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ? ORDER BY t.name");
  const depStmt = db.prepare("SELECT d.blocked_by_id AS id, t.status FROM task_deps d JOIN tasks t ON t.id = d.blocked_by_id WHERE d.task_id = ?");
  const subStmt = db.prepare(
    `WITH RECURSIVE d(id) AS (
       SELECT id FROM tasks WHERE parent_id = ?
       UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
     SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done FROM tasks WHERE id IN (SELECT id FROM d)`,
  );
  const checkStmt = db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM checklist_items WHERE task_id = ?");
  const timeStmt = db.prepare(
    `SELECT COALESCE(SUM(strftime('%s', COALESCE(ended_at, ?)) - strftime('%s', started_at)), 0) AS secs,
            COALESCE(SUM(ended_at IS NULL), 0) AS running FROM time_entries WHERE task_id = ?`,
  );
  const commentStmt = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE task_id = ?");
  const wsStmt = db.prepare("SELECT workspace_id AS ws FROM projects WHERE id = ?");

  const hydrate = (rows: TaskRow[], userId: number) => {
    const nowIso = new Date().toISOString().replace("Z", "").replace("T", " ");
    return rows.map(({ recurrence_rule, ...r }) => {
      const deps = depStmt.all(r.id) as { id: number; status: string }[];
      const sub = subStmt.get(r.id) as { total: number; done: number };
      const check = checkStmt.get(r.id) as { total: number; done: number };
      const time = timeStmt.get(nowIso, r.id) as { secs: number; running: number };
      const ws = r.project_id === null ? null : ((wsStmt.get(r.project_id) as { ws: number | null } | undefined)?.ws ?? null);
      const role = ws === null ? null : roleIn(db, ws, userId);
      // What the caller may do, so the UI can hide controls that would only fail.
      const access = ws === null || atLeast(role, "admin") ? "admin" : atLeast(role, "member") ? "write" : "read";
      return {
        ...r,
        id: r.id,
        recurrence: parseRule(recurrence_rule),
        tags: (tagStmt.all(r.id) as { name: string }[]).map((t) => t.name),
        blocked_by: deps.map((d) => d.id),
        blocked: deps.some((d) => d.status !== "done"),
        subtasks_total: sub.total,
        subtasks_done: sub.done,
        checklist_total: check.total,
        checklist_done: check.done,
        tracked_min: Math.round(time.secs / 60),
        timer_running: time.running > 0,
        workspace_id: ws,
        access,
        can_delete: access === "admin" || (access === "write" && r.user_id === userId),
        comment_count: (commentStmt.get(r.id) as { n: number }).n,
      };
    });
  };

  /** The task as the caller sees it; 404 if they can't see it. */
  const getTask = (userId: number, id: number | string) => {
    const a = readableTask(db, userId, id);
    return hydrate([a.row], userId)[0] as ReturnType<typeof hydrate>[number] & { due_at: string | null; remind_at: string | null; status: string };
  };

  const isInSubtree = (id: number, rootId: number) =>
    !!db
      .prepare(
        `WITH RECURSIVE anc(id) AS (
           SELECT ? UNION ALL SELECT t.parent_id FROM tasks t JOIN anc ON t.id = anc.id WHERE t.parent_id IS NOT NULL)
         SELECT 1 FROM anc WHERE id = ?`,
      )
      .get(id, rootId);

  const descendantIds = (rootId: number): number[] =>
    (
      db
        .prepare(
          `WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
           SELECT id FROM d`,
        )
        .all(rootId) as { id: number }[]
    ).map((r) => r.id);

  const setTags = (userId: number, taskId: number, names: string[]) => {
    db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(taskId);
    for (const name of new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))) {
      db.prepare("INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)").run(userId, name);
      const tag = db.prepare("SELECT id FROM tags WHERE user_id = ? AND name = ?").get(userId, name) as { id: number };
      db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)").run(taskId, tag.id);
    }
  };

  const assertAssignable = (workspaceId: number | null, assigneeId: number) => {
    if (workspaceId === null) throw new HttpError(400, "Only tasks in a workspace can be assigned");
    if (!isMemberAtLeast(db, workspaceId, assigneeId, "member")) throw new HttpError(400, "The assignee must be a member of the workspace");
  };

  // ---------- projects ----------
  app.get("/api/projects", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT ${PROJECT_COLS.replace(/\b(\w+)\b/g, "p.$1")} FROM projects p
           WHERE (p.workspace_id IS NULL AND p.user_id = ?) OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)
           ORDER BY p.name`,
        )
        .all(uid(req), uid(req)),
    );
  });

  app.post("/api/projects", auth, (req, res) => {
    const b = projectBody.partial({ color: true, workspace_id: true }).parse(req.body);
    const me = uid(req);
    if (b.workspace_id != null) {
      const role = roleIn(db, b.workspace_id, me);
      if (!role) throw new HttpError(404, "Workspace not found");
      if (!atLeast(role, "member")) throw FORBIDDEN();
    }
    const info = db
      .prepare("INSERT INTO projects (user_id, name, color, workspace_id) VALUES (?, ?, COALESCE(?, '#4f46e5'), ?)")
      .run(me, b.name, b.color ?? null, b.workspace_id ?? null);
    logActivity(db, b.workspace_id ?? null, me, "project_created", null, { name: b.name });
    res.status(201).json(db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(info.lastInsertRowid));
  });

  app.patch("/api/projects/:id", auth, (req, res) => {
    const b = projectBody.pick({ name: true, color: true }).partial().parse(req.body);
    const pa = projectAccess(db, uid(req), Number(req.params.id));
    if (!pa) throw new HttpError(404, "Project not found");
    if (pa.workspaceId !== null && !(pa.canManage || (pa.canWrite && pa.creatorId === uid(req)))) throw FORBIDDEN();
    db.prepare("UPDATE projects SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?").run(b.name ?? null, b.color ?? null, pa.id);
    res.json(db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(pa.id));
  });

  app.delete("/api/projects/:id", auth, (req, res) => {
    const pa = projectAccess(db, uid(req), Number(req.params.id));
    if (!pa) throw new HttpError(404, "Project not found");
    if (pa.workspaceId !== null) {
      if (!pa.canManage) throw FORBIDDEN();
      // Shared work must not silently become somebody's private task: it is deleted with its project.
      db.transaction(() => {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?").get(pa.id) as { n: number }).n;
        db.prepare("DELETE FROM tasks WHERE project_id = ?").run(pa.id);
        db.prepare("DELETE FROM projects WHERE id = ?").run(pa.id);
        logActivity(db, pa.workspaceId, uid(req), "project_deleted", null, { name: pa.name, tasks: n });
      })();
    } else {
      db.prepare("DELETE FROM projects WHERE id = ?").run(pa.id); // private tasks fall back to the inbox
    }
    res.status(204).end();
  });

  // ---------- tags ----------
  app.get("/api/tags", auth, (req, res) => {
    // Own tags plus tags on tasks I can see (e.g. added by teammates), one entry per name.
    res.json(
      db
        .prepare(
          `SELECT MIN(id) AS id, name FROM (
             SELECT id, name FROM tags WHERE user_id = ?
             UNION
             SELECT g.id, g.name FROM tags g JOIN task_tags tt ON tt.tag_id = g.id JOIN tasks t ON t.id = tt.task_id WHERE ${visibleTasksSql("t")}
           ) GROUP BY name ORDER BY name`,
        )
        .all(uid(req), ...visibleArgs(uid(req))),
    );
  });
  app.delete("/api/tags/:id", auth, (req, res) => {
    const info = db.prepare("DELETE FROM tags WHERE id = ? AND user_id = ?").run(req.params.id, uid(req));
    if (!info.changes) throw new HttpError(404, "Tag not found");
    res.status(204).end();
  });

  // ---------- tasks ----------
  const listQuery = z.object({
    project_id: z.coerce.number().int().optional(),
    workspace_id: z.coerce.number().int().optional(),
    assignee: z.union([z.literal("me"), z.literal("none"), z.coerce.number().int()]).optional(),
    parent_id: z.union([z.literal("null"), z.coerce.number().int()]).optional(),
    tag: z.string().optional(),
    status: z.enum(["todo", "doing", "done", "open"]).optional(),
    priority: z.coerce.number().int().min(0).max(3).optional(),
    due_before: iso.optional(),
    due_after: iso.optional(),
    q: z.string().optional(),
    sort: z.enum(["due", "position"]).optional(),
  });

  app.get("/api/tasks", auth, (req, res) => {
    const me = uid(req);
    const f = listQuery.parse(req.query);
    const where = [visibleTasksSql("t")];
    const args: unknown[] = [...visibleArgs(me)];
    const add = (sql: string, ...a: unknown[]) => {
      where.push(sql);
      args.push(...a);
    };
    if (f.project_id !== undefined) add("t.project_id = ?", f.project_id);
    if (f.workspace_id !== undefined) add("t.project_id IN (SELECT id FROM projects WHERE workspace_id = ?)", f.workspace_id);
    if (f.assignee === "me") add("t.assignee_id = ?", me);
    else if (f.assignee === "none") where.push("t.assignee_id IS NULL");
    else if (f.assignee !== undefined) add("t.assignee_id = ?", f.assignee);
    if (f.parent_id === "null") where.push("t.parent_id IS NULL");
    else if (f.parent_id !== undefined) add("t.parent_id = ?", f.parent_id);
    if (f.status === "open") where.push("t.status != 'done'");
    else if (f.status) add("t.status = ?", f.status);
    if (f.priority !== undefined) add("t.priority = ?", f.priority);
    if (f.due_before) add("t.due_at <= ?", f.due_before);
    if (f.due_after) add("t.due_at >= ?", f.due_after);
    if (f.q) add("(t.title LIKE ? OR t.notes LIKE ?)", `%${f.q}%`, `%${f.q}%`);
    if (f.tag)
      add("EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)", f.tag.toLowerCase());
    const rows = db
      .prepare(
        `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")}
         ORDER BY ${f.sort === "position" ? "t.position, t.id" : "t.due_at IS NULL, t.due_at, t.priority DESC, t.id"}`,
      )
      .all(...args) as TaskRow[];
    res.json(hydrate(rows, me));
  });

  app.get("/api/tasks/:id", auth, (req, res) => {
    res.json(getTask(uid(req), String(req.params.id)));
  });

  app.post("/api/tasks", auth, (req, res) => {
    const me = uid(req);
    const b = taskCreate.parse(req.body);

    let projectId = b.project_id ?? null;
    let parent: TaskAccess | null = null;
    if (b.parent_id != null) {
      parent = taskAccess(db, me, b.parent_id);
      if (!parent || !parent.canWrite) throw new HttpError(400, "Invalid parent_id");
      if (b.project_id === undefined) projectId = parent.row.project_id; // a subtask lives where its parent lives
    }
    let workspaceId: number | null = null;
    if (projectId !== null) {
      const pa = projectAccess(db, me, projectId);
      if (!pa) throw new HttpError(400, "Invalid project_id");
      if (!pa.canWrite) throw FORBIDDEN();
      workspaceId = pa.workspaceId;
    }
    if (parent && parent.workspaceId !== workspaceId) throw new HttpError(400, "A subtask must be in the same workspace as its parent");
    if (b.assignee_id != null) assertAssignable(workspaceId, b.assignee_id);

    const id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO tasks (user_id, project_id, parent_id, assignee_id, title, notes, priority, status, due_at, remind_at, recurrence_rule, completed_at, position, estimate_min)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE user_id = ?)), ?)`,
        )
        .run(
          me, projectId, b.parent_id ?? null, b.assignee_id ?? null, b.title, b.notes ?? "", b.priority ?? 0, b.status ?? "todo",
          b.due_at ?? null, b.remind_at ?? null, b.recurrence ? JSON.stringify(b.recurrence) : null,
          b.status === "done" ? new Date().toISOString() : null, b.position ?? null, me, b.estimate_min ?? null,
        );
      const taskId = Number(info.lastInsertRowid);
      setTags(me, taskId, b.tags ?? []);
      logActivity(db, workspaceId, me, "task_created", taskId, { title: b.title });
      if (b.assignee_id != null) {
        logActivity(db, workspaceId, me, "task_assigned", taskId, { title: b.title, assignee_id: b.assignee_id });
        notify(db, { userId: b.assignee_id, kind: "assigned", actorId: me, taskId, workspaceId, title: b.title });
      }
      return taskId;
    })();
    res.status(201).json(getTask(me, id));
  });

  app.patch("/api/tasks/:id", auth, (req, res) => {
    const me = uid(req);
    const b = taskUpdate.parse(req.body);
    const ta = writableTask(db, me, String(req.params.id));
    const current = ta.row;
    const taskId = current.id;

    // Where the task will live after this edit.
    let newProject = current.project_id;
    let newWs = ta.workspaceId;
    if (b.project_id !== undefined && b.project_id !== current.project_id) {
      if (b.project_id === null) {
        newProject = null;
        newWs = null;
      } else {
        const pa = projectAccess(db, me, b.project_id);
        if (!pa) throw new HttpError(400, "Invalid project_id");
        if (!pa.canWrite) throw FORBIDDEN();
        newProject = pa.id;
        newWs = pa.workspaceId;
      }
    }
    const scopeChange = newWs !== ta.workspaceId;
    // Moving work between private and shared (or between workspaces) is for its author, or a workspace admin moving it elsewhere shared.
    if (scopeChange && !(current.user_id === me || (ta.canManage && newWs !== null))) throw FORBIDDEN();

    let newParent = b.parent_id === undefined ? current.parent_id : b.parent_id;
    if (b.parent_id != null) {
      const pa = taskAccess(db, me, b.parent_id);
      if (!pa || !pa.canWrite) throw new HttpError(400, "Invalid parent_id");
      if (pa.workspaceId !== newWs) throw new HttpError(400, "A subtask must be in the same workspace as its parent");
      if (isInSubtree(b.parent_id, taskId)) throw new HttpError(400, "A task cannot be moved under itself or its own subtasks");
    }
    if (scopeChange && b.parent_id === undefined && current.parent_id !== null) newParent = null; // leaves its parent behind

    const current_ = getTask(me, taskId);
    if (b.status === "done" && current.status !== "done" && current_.blocked) throw new HttpError(409, "Task is blocked by unfinished tasks");

    let newAssignee = b.assignee_id === undefined ? current.assignee_id : b.assignee_id;
    if (b.assignee_id != null) assertAssignable(newWs, b.assignee_id);
    // An assignee who isn't in the destination workspace can't keep the task.
    if (scopeChange && b.assignee_id === undefined && newAssignee !== null && !(newWs !== null && isMemberAtLeast(db, newWs, newAssignee, "member"))) newAssignee = null;

    db.transaction(() => {
      const sets: string[] = [];
      const args: unknown[] = [];
      const set = (col: string, val: unknown) => {
        sets.push(`${col} = ?`);
        args.push(val);
      };
      for (const key of ["title", "notes", "priority", "status", "due_at", "position", "estimate_min"] as const) {
        if (b[key] !== undefined) set(key, b[key]);
      }
      if (newProject !== current.project_id) set("project_id", newProject);
      if (newParent !== current.parent_id) set("parent_id", newParent);
      if (newAssignee !== current.assignee_id) set("assignee_id", newAssignee);
      if (b.remind_at !== undefined) {
        set("remind_at", b.remind_at);
        set("reminded_at", null);
        set("ack", 0);
      }
      if (b.recurrence !== undefined) set("recurrence_rule", b.recurrence ? JSON.stringify(b.recurrence) : null);
      if (b.status !== undefined) set("completed_at", b.status === "done" ? new Date().toISOString() : null);
      if (sets.length) db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args, taskId);
      if (b.tags) setTags(me, taskId, b.tags);

      if (scopeChange) {
        // Subtasks travel with their parent, and nothing may keep a link across the new boundary.
        const family = [taskId, ...descendantIds(taskId)];
        const marks = family.map(() => "?").join(",");
        db.prepare(`UPDATE tasks SET project_id = ? WHERE id IN (${marks})`).run(newProject, ...family);
        // Subtasks lose their assignees: those people may not be in the destination.
        db.prepare(`UPDATE tasks SET assignee_id = NULL WHERE id IN (${marks}) AND id != ?`).run(...family, taskId);
        const outside = db
          .prepare(
            `SELECT d.task_id, d.blocked_by_id FROM task_deps d
             WHERE (d.task_id IN (${marks}) AND d.blocked_by_id NOT IN (${marks})) OR (d.blocked_by_id IN (${marks}) AND d.task_id NOT IN (${marks}))`,
          )
          .all(...family, ...family, ...family, ...family) as { task_id: number; blocked_by_id: number }[];
        for (const d of outside) db.prepare("DELETE FROM task_deps WHERE task_id = ? AND blocked_by_id = ?").run(d.task_id, d.blocked_by_id);
        const title = (b.title ?? current.title) as string;
        logActivity(db, ta.workspaceId, me, "task_moved", taskId, { title, away: true });
        logActivity(db, newWs, me, "task_moved", taskId, { title });
      }

      const title = (b.title ?? current.title) as string;
      if (b.status !== undefined && b.status !== current.status) {
        if (b.status === "done") logActivity(db, newWs, me, "task_completed", taskId, { title });
        else if (current.status === "done") logActivity(db, newWs, me, "task_reopened", taskId, { title });
      }
      if (newAssignee !== current.assignee_id) {
        if (newAssignee === null) logActivity(db, newWs, me, "task_unassigned", taskId, { title, assignee_id: current.assignee_id });
        else {
          logActivity(db, newWs, me, "task_assigned", taskId, { title, assignee_id: newAssignee });
          notify(db, { userId: newAssignee, kind: "assigned", actorId: me, taskId, workspaceId: newWs, title });
        }
      }
    })();
    res.json(getTask(me, taskId));
  });

  app.delete("/api/tasks/:id", auth, (req, res) => {
    const ta = readableTask(db, uid(req), String(req.params.id));
    if (!ta.canDelete) throw FORBIDDEN();
    db.transaction(() => {
      logActivity(db, ta.workspaceId, uid(req), "task_deleted", ta.row.id, { title: ta.row.title });
      db.prepare("DELETE FROM tasks WHERE id = ?").run(ta.row.id);
    })();
    res.status(204).end();
  });

  app.post("/api/tasks/:id/complete", auth, (req, res) => {
    const me = uid(req);
    const ta = writableTask(db, me, String(req.params.id));
    const task = getTask(me, ta.row.id);
    if (task.status === "done") throw new HttpError(409, "Task already completed");
    if (task.blocked) throw new HttpError(409, "Task is blocked by unfinished tasks");
    const nextId = db.transaction(() => {
      db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(new Date().toISOString(), task.id);
      logActivity(db, ta.workspaceId, me, "task_completed", task.id, { title: task.title });
      if (!task.recurrence) return null;
      const due = nextOccurrence(task.due_at ?? new Date().toISOString(), task.recurrence);
      const lead = task.remind_at && task.due_at ? Date.parse(task.due_at) - Date.parse(task.remind_at) : null;
      const remind = lead !== null ? new Date(Date.parse(due) - lead).toISOString() : null;
      const info = db
        .prepare(
          `INSERT INTO tasks (user_id, project_id, parent_id, assignee_id, title, notes, priority, status, due_at, remind_at, recurrence_rule, position, estimate_min)
           SELECT user_id, project_id, parent_id, assignee_id, title, notes, priority, 'todo', ?, ?, recurrence_rule, position, estimate_min FROM tasks WHERE id = ?`,
        )
        .run(due, remind, task.id);
      setTags(me, Number(info.lastInsertRowid), task.tags);
      return Number(info.lastInsertRowid);
    })();
    res.json({ completed: getTask(me, task.id), next: nextId ? getTask(me, nextId) : null });
  });

  // ---------- reminders (fired, not yet dismissed): for the assignee, or the author when nobody is assigned ----------
  app.get("/api/notifications", auth, (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT t.id, t.title, t.due_at, t.remind_at FROM tasks t
           WHERE ${visibleTasksSql("t")} AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND t.user_id = ?))
             AND t.status != 'done' AND t.reminded_at IS NOT NULL AND t.ack = 0
           ORDER BY t.remind_at`,
        )
        .all(...visibleArgs(uid(req)), uid(req), uid(req)),
    );
  });
  app.post("/api/notifications/:id/ack", auth, (req, res) => {
    const ta = readableTask(db, uid(req), String(req.params.id));
    db.prepare("UPDATE tasks SET ack = 1 WHERE id = ?").run(ta.row.id);
    res.status(204).end();
  });

  return { getTask, setTags, userName: (id: number) => userName(db, id) };
}
