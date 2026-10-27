import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import {
  FORBIDDEN, atLeast, isMemberAtLeast, projectAccess, readableTask, roleIn, taskAccess, visibleArgs, visibleTasksSql, writableTask,
  type Role, type TaskAccess, type TaskRow,
} from "./access.js";
import { inChunks, type DB, type Queryable } from "./db.js";
import { countWhere, epoch, likeCI } from "./dialect.js";
import { logActivity, notify, userName } from "./events.js";
import { HttpError, parseId } from "./http-error.js";
import { nextOccurrence, parseRule, recurrenceSchema } from "./recurrence.js";
import { assertLeadAllowed } from "./pm.js";
import { sla } from "./sla.js";
import { PROJECT_TYPES, keepOrPick, seedProjectStatuses, statusFits, statusFor } from "./statuses.js";

const iso = z.string().datetime({ offset: true });

const taskFields = {
  title: z.string().min(1).max(500),
  notes: z.string().max(10000),
  project_id: z.number().int().nullable(),
  parent_id: z.number().int().nullable(),
  assignee_id: z.number().int().nullable(),
  priority: z.number().int().min(0).max(3),
  status: z.enum(["todo", "doing", "done"]),
  status_id: z.number().int().nullable(),
  start_at: iso.nullable(),
  milestone_id: z.number().int().nullable(),
  value: z.number().min(0).max(1e12).nullable(),
  requester_name: z.string().trim().max(100).nullable(),
  requester_email: z.string().trim().email().max(200).nullable(),
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
  type: z.enum(PROJECT_TYPES),
  description: z.string().max(5000),
  lead_id: z.number().int().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter currency code, like USD"),
  first_response_hours: z.number().int().min(1).max(8760).nullable(),
  resolution_hours: z.number().int().min(1).max(8760).nullable(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date").nullable(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date").nullable(),
});
const PROJECT_COLS = "id, name, color, workspace_id, type, description, stage, lead_id, start_date, target_date, currency, first_response_hours, resolution_hours";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

/** Groups rows by their `task_id` (or another key). */
function groupBy<T>(rows: T[], key: (r: T) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function registerTasks(app: Express, { db, auth, uid }: Deps) {
  const D = db.dialect;

  // ---------- hydration ----------
  /**
   * Adds everything the UI shows beside a task (tags, dependencies, progress, time, comment count, and what the caller
   * may do with it). It runs one query per kind of data for the whole list, not one per task, so a long list costs
   * the same few round trips whether the database is a local file or a server across a network.
   */
  async function hydrate(q: Queryable, rows: TaskRow[], userId: number) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const nowIso = new Date().toISOString();

    const [tagRows, depRows, subRows, checkRows, timeRows, commentRows, meetingRows] = await Promise.all([
      inChunks(ids, (m, a) => q.all<{ task_id: number; name: string }>(`SELECT tt.task_id, g.name FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id IN (${m}) ORDER BY g.name`, ...a)),
      inChunks(ids, (m, a) => q.all<{ task_id: number; id: number; status: string }>(`SELECT d.task_id, d.blocked_by_id AS id, t.status FROM task_deps d JOIN tasks t ON t.id = d.blocked_by_id WHERE d.task_id IN (${m})`, ...a)),
      inChunks(ids, (m, a) =>
        q.all<{ root: number; total: number; done: number }>(
          `WITH RECURSIVE d(root, id, status) AS (
             SELECT parent_id, id, status FROM tasks WHERE parent_id IN (${m})
             UNION ALL SELECT d.root, t.id, t.status FROM tasks t JOIN d ON t.parent_id = d.id)
           SELECT root, COUNT(*) AS total, ${countWhere("status = 'done'")} AS done FROM d GROUP BY root`,
          ...a,
        ),
      ),
      inChunks(ids, (m, a) => q.all<{ task_id: number; total: number; done: number }>(`SELECT task_id, COUNT(*) AS total, ${countWhere("done = 1")} AS done FROM checklist_items WHERE task_id IN (${m}) GROUP BY task_id`, ...a)),
      inChunks(ids, (m, a) =>
        q.all<{ task_id: number; secs: number; running: number }>(
          `SELECT task_id, COALESCE(SUM(${epoch(D, "COALESCE(ended_at, ?)")} - ${epoch(D, "started_at")}), 0) AS secs, ${countWhere("ended_at IS NULL")} AS running
           FROM time_entries WHERE task_id IN (${m}) GROUP BY task_id`,
          nowIso, ...a,
        ),
      ),
      inChunks(ids, (m, a) => q.all<{ task_id: number; n: number }>(`SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (${m}) GROUP BY task_id`, ...a)),
      inChunks(ids, (m, a) => q.all<{ task_id: number; n: number }>(`SELECT task_id, COUNT(*) AS n FROM meeting_tasks WHERE task_id IN (${m}) GROUP BY task_id`, ...a)),
    ]);

    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((p): p is number => p !== null))];
    const [projects, memberships] = await Promise.all([
      inChunks(projectIds, (m, a) => q.all<{ id: number; workspace_id: number | null; first_response_hours: number | null; resolution_hours: number | null }>(`SELECT id, workspace_id, first_response_hours, resolution_hours FROM projects WHERE id IN (${m})`, ...a)),
      q.all<{ workspace_id: number; role: Role }>("SELECT workspace_id, role FROM workspace_members WHERE user_id = ?", userId),
    ]);
    const wsOfProject = new Map(projects.map((p) => [p.id, p.workspace_id]));
    const targetsOf = new Map(projects.map((p) => [p.id, { first_response_hours: p.first_response_hours, resolution_hours: p.resolution_hours }]));
    const now = new Date();
    const roleOf = new Map(memberships.map((m) => [m.workspace_id, m.role]));

    const tags = groupBy(tagRows, (r) => r.task_id);
    const deps = groupBy(depRows, (r) => r.task_id);
    const subs = new Map(subRows.map((r) => [r.root, r]));
    const checks = new Map(checkRows.map((r) => [r.task_id, r]));
    const times = new Map(timeRows.map((r) => [r.task_id, r]));
    const comments = new Map(commentRows.map((r) => [r.task_id, r.n]));
    const meetings = new Map(meetingRows.map((r) => [r.task_id, r.n]));

    return rows.map(({ recurrence_rule, ...r }) => {
      const taskDeps = deps.get(r.id) ?? [];
      const sub = subs.get(r.id);
      const check = checks.get(r.id);
      const time = times.get(r.id);
      const ws = r.project_id === null ? null : (wsOfProject.get(r.project_id) ?? null);
      const role = ws === null ? null : (roleOf.get(ws) ?? null);
      // What the caller may do, so the UI can hide controls that would only fail.
      const access = ws === null || atLeast(role, "admin") ? "admin" : atLeast(role, "member") ? "write" : "read";
      return {
        ...r,
        id: r.id,
        recurrence: parseRule(recurrence_rule),
        tags: (tags.get(r.id) ?? []).map((t) => t.name),
        blocked_by: taskDeps.map((d) => d.id),
        blocked: taskDeps.some((d) => d.status !== "done"),
        subtasks_total: sub?.total ?? 0,
        subtasks_done: sub?.done ?? 0,
        checklist_total: check?.total ?? 0,
        checklist_done: check?.done ?? 0,
        tracked_min: Math.round((time?.secs ?? 0) / 60),
        timer_running: (time?.running ?? 0) > 0,
        workspace_id: ws,
        access,
        can_delete: access === "admin" || (access === "write" && r.user_id === userId),
        comment_count: comments.get(r.id) ?? 0,
        meeting_count: meetings.get(r.id) ?? 0,
        // Support tickets only: the clocks for the project's service targets.
        sla: r.ticket_no != null && r.project_id !== null ? sla(r as unknown as Parameters<typeof sla>[0], targetsOf.get(r.project_id)!, now) : null,
      };
    });
  }

  /** The task as the caller sees it; 404 if they can't see it. */
  const getTask = async (userId: number, id: number, q: Queryable = db) => {
    const a = await readableTask(q, userId, id);
    return (await hydrate(q, [a.row], userId))[0] as Awaited<ReturnType<typeof hydrate>>[number] & {
      due_at: string | null;
      remind_at: string | null;
      status: string;
      status_id: number | null;
      start_at: string | null;
      milestone_id: number | null;
      ticket_no: number | null;
      first_response_at: string | null;
    };
  };

  const isInSubtree = async (q: Queryable, id: number, rootId: number) =>
    !!(await q.get(
      `WITH RECURSIVE anc(id) AS (
         SELECT CAST(? AS INTEGER) UNION ALL SELECT t.parent_id FROM tasks t JOIN anc ON t.id = anc.id WHERE t.parent_id IS NOT NULL)
       SELECT 1 FROM anc WHERE id = ?`,
      id,
      rootId,
    ));

  const descendantIds = async (q: Queryable, rootId: number): Promise<number[]> =>
    (
      await q.all<{ id: number }>(
        `WITH RECURSIVE d(id) AS (SELECT id FROM tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
         SELECT id FROM d`,
        rootId,
      )
    ).map((r) => r.id);

  const setTags = async (q: Queryable, userId: number, taskId: number, names: string[]) => {
    await q.run("DELETE FROM task_tags WHERE task_id = ?", taskId);
    for (const name of new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))) {
      await q.run("INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", userId, name);
      const tag = (await q.get<{ id: number }>("SELECT id FROM tags WHERE user_id = ? AND name = ?", userId, name))!;
      await q.run("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING", taskId, tag.id);
    }
  };

  const checkDates = (start: string | null, due: string | null) => {
    if (start && due && Date.parse(start) > Date.parse(due)) throw new HttpError(400, "The start can't be after the due date");
  };
  const checkMilestone = async (q: Queryable, milestoneId: number, projectId: number | null) => {
    if (projectId === null || !(await q.get("SELECT 1 FROM milestones WHERE id = ? AND project_id = ?", milestoneId, projectId))) {
      throw new HttpError(400, "That milestone doesn't belong to this project");
    }
  };

  /** Tickets are numbered per support project (#1, #2…); work in any other project has no number. */
  const nextTicketNo = async (q: Queryable, projectId: number | null): Promise<number | null> => {
    if (projectId === null) return null;
    const p = await q.get<{ type: string }>("SELECT type FROM projects WHERE id = ?", projectId);
    if (p?.type !== "support") return null;
    return (await q.get<{ n: number }>("SELECT COALESCE(MAX(ticket_no), 0) + 1 AS n FROM tasks WHERE project_id = ?", projectId))!.n;
  };

  const assertAssignable = async (q: Queryable, workspaceId: number | null, assigneeId: number) => {
    if (workspaceId === null) throw new HttpError(400, "Only tasks in a workspace can be assigned");
    if (!(await isMemberAtLeast(q, workspaceId, assigneeId, "member"))) throw new HttpError(400, "The assignee must be a member of the workspace");
  };

  // ---------- projects ----------
  app.get("/api/projects", auth, async (req, res) => {
    res.json(
      await db.all(
        `SELECT ${PROJECT_COLS.replace(/\b(\w+)\b/g, "p.$1")} FROM projects p
         WHERE (p.workspace_id IS NULL AND p.user_id = ?) OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)
         ORDER BY p.name, p.id`,
        uid(req),
        uid(req),
      ),
    );
  });

  app.post("/api/projects", auth, async (req, res) => {
    const b = projectBody.partial().required({ name: true }).parse(req.body);
    const me = uid(req);
    if (b.workspace_id != null) {
      const role = await roleIn(db, b.workspace_id, me);
      if (!role) throw new HttpError(404, "Workspace not found");
      if (!atLeast(role, "member")) throw FORBIDDEN();
    }
    if (b.lead_id != null) await assertLeadAllowed(db, b.workspace_id ?? null, me, b.lead_id);
    if (b.start_date && b.target_date && b.target_date < b.start_date) throw new HttpError(400, "The target date can't be before the start date");
    const type = b.type ?? "initiative";
    if (type === "pipeline") throw new HttpError(400, "Sales pipelines now live under Sales, with their own leads, accounts and deals");
    const id = await db.tx(async (t) => {
      const projectId = await t.insert(
        "INSERT INTO projects (user_id, name, color, workspace_id, type, description, lead_id, start_date, target_date) VALUES (?, ?, COALESCE(?, '#4f46e5'), ?, ?, ?, ?, ?, ?)",
        me, b.name, b.color ?? null, b.workspace_id ?? null, type, b.description ?? "", b.lead_id ?? null, b.start_date ?? null, b.target_date ?? null,
      );
      await seedProjectStatuses(t, projectId, type);
      await logActivity(t, b.workspace_id ?? null, me, "project_created", null, { name: b.name });
      return projectId;
    });
    res.status(201).json(await db.get(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`, id));
  });

  app.patch("/api/projects/:id", auth, async (req, res) => {
    const b = projectBody.pick({ name: true, color: true, type: true, description: true, lead_id: true, start_date: true, target_date: true, currency: true, first_response_hours: true, resolution_hours: true }).partial().parse(req.body);
    const pa = await projectAccess(db, uid(req), parseId(req.params.id, "Project not found"));
    if (!pa) throw new HttpError(404, "Project not found");
    if (pa.workspaceId !== null && !(pa.canManage || (pa.canWrite && pa.creatorId === uid(req)))) throw FORBIDDEN();
    if (b.lead_id != null) await assertLeadAllowed(db, pa.workspaceId, pa.creatorId, b.lead_id);
    if (b.type === "pipeline" && (await db.get<{ type: string }>("SELECT type FROM projects WHERE id = ?", pa.id))?.type !== "pipeline") {
      throw new HttpError(400, "Sales pipelines now live under Sales, with their own leads, accounts and deals");
    }
    await db.tx(async (t) => {
      await t.run("UPDATE projects SET name = COALESCE(?, name), color = COALESCE(?, color), type = COALESCE(?, type), description = COALESCE(?, description) WHERE id = ?", b.name ?? null, b.color ?? null, b.type ?? null, b.description ?? null, pa.id);
      // These can be cleared, so they are set only when given (null clears).
      if (b.lead_id !== undefined) await t.run("UPDATE projects SET lead_id = ? WHERE id = ?", b.lead_id, pa.id);
      if (b.currency !== undefined) await t.run("UPDATE projects SET currency = ? WHERE id = ?", b.currency, pa.id);
      if (b.first_response_hours !== undefined) await t.run("UPDATE projects SET first_response_hours = ? WHERE id = ?", b.first_response_hours, pa.id);
      if (b.resolution_hours !== undefined) await t.run("UPDATE projects SET resolution_hours = ? WHERE id = ?", b.resolution_hours, pa.id);
      if (b.start_date !== undefined) await t.run("UPDATE projects SET start_date = ? WHERE id = ?", b.start_date, pa.id);
      if (b.target_date !== undefined) await t.run("UPDATE projects SET target_date = ? WHERE id = ?", b.target_date, pa.id);
    });
    res.json(await db.get(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`, pa.id));
  });

  app.delete("/api/projects/:id", auth, async (req, res) => {
    const pa = await projectAccess(db, uid(req), parseId(req.params.id, "Project not found"));
    if (!pa) throw new HttpError(404, "Project not found");
    if (pa.workspaceId !== null) {
      if (!pa.canManage) throw FORBIDDEN();
      // Shared work must not silently become somebody's private task: it is deleted with its project.
      await db.tx(async (t) => {
        const n = (await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?", pa.id))!.n;
        await t.run("DELETE FROM tasks WHERE project_id = ?", pa.id);
        await t.run("DELETE FROM projects WHERE id = ?", pa.id);
        await logActivity(t, pa.workspaceId, uid(req), "project_deleted", null, { name: pa.name, tasks: n });
      });
    } else {
      await db.run("DELETE FROM projects WHERE id = ?", pa.id); // private tasks fall back to the inbox
    }
    res.status(204).end();
  });

  // ---------- tags ----------
  app.get("/api/tags", auth, async (req, res) => {
    // Own tags plus tags on tasks I can see (e.g. added by teammates), one entry per name.
    res.json(
      await db.all(
        `SELECT MIN(id) AS id, name FROM (
           SELECT id, name FROM tags WHERE user_id = ?
           UNION
           SELECT g.id, g.name FROM tags g JOIN task_tags tt ON tt.tag_id = g.id JOIN tasks t ON t.id = tt.task_id WHERE ${visibleTasksSql("t")}
         ) x GROUP BY name ORDER BY name`,
        uid(req),
        ...visibleArgs(uid(req)),
      ),
    );
  });
  app.delete("/api/tags/:id", auth, async (req, res) => {
    const info = await db.run("DELETE FROM tags WHERE id = ? AND user_id = ?", parseId(req.params.id, "Tag not found"), uid(req));
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
    status_id: z.coerce.number().int().optional(),
    priority: z.coerce.number().int().min(0).max(3).optional(),
    due_before: iso.optional(),
    due_after: iso.optional(),
    q: z.string().optional(),
    sort: z.enum(["due", "position"]).optional(),
  });

  app.get("/api/tasks", auth, async (req, res) => {
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
    if (f.status_id !== undefined) add("t.status_id = ?", f.status_id);
    if (f.priority !== undefined) add("t.priority = ?", f.priority);
    if (f.due_before) add("t.due_at <= ?", f.due_before);
    if (f.due_after) add("t.due_at >= ?", f.due_after);
    if (f.q) add(`(${likeCI("t.title")} OR ${likeCI("t.notes")})`, `%${f.q}%`, `%${f.q}%`);
    if (f.tag)
      add("EXISTS (SELECT 1 FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id = t.id AND g.name = ?)", f.tag.toLowerCase());
    const rows = await db.all<TaskRow>(
      `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")}
       ORDER BY ${f.sort === "position" ? "t.position, t.id" : "t.due_at IS NULL, t.due_at, t.priority DESC, t.id"}`,
      ...args,
    );
    res.json(await hydrate(db, rows, me));
  });

  app.get("/api/tasks/:id", auth, async (req, res) => {
    res.json(await getTask(uid(req), parseId(req.params.id, "Task not found")));
  });

  app.post("/api/tasks", auth, async (req, res) => {
    const me = uid(req);
    const b = taskCreate.parse(req.body);

    let projectId = b.project_id ?? null;
    let parent: TaskAccess | null = null;
    if (b.parent_id != null) {
      parent = await taskAccess(db, me, b.parent_id);
      if (!parent || !parent.canWrite) throw new HttpError(400, "Invalid parent_id");
      if (b.project_id === undefined) projectId = parent.row.project_id; // a subtask lives where its parent lives
    }
    let workspaceId: number | null = null;
    if (projectId !== null) {
      const pa = await projectAccess(db, me, projectId);
      if (!pa) throw new HttpError(400, "Invalid project_id");
      if (!pa.canWrite) throw FORBIDDEN();
      workspaceId = pa.workspaceId;
      if (pa.stage === "archived") throw new HttpError(409, "This project is archived. Restore it to add tasks.");
    }
    let status = b.status ?? "todo";
    let statusId: number | null;
    if (b.status_id != null) {
      const s = await statusFits(db, b.status_id, projectId, workspaceId);
      if (b.status !== undefined && b.status !== s.category) throw new HttpError(400, "status and status_id disagree");
      status = s.category;
      statusId = s.id;
    } else {
      statusId = await statusFor(db, projectId, workspaceId, status);
    }
    if (parent && parent.workspaceId !== workspaceId) throw new HttpError(400, "A subtask must be in the same workspace as its parent");
    if (b.assignee_id != null) await assertAssignable(db, workspaceId, b.assignee_id);
    checkDates(b.start_at ?? null, b.due_at ?? null);
    if (b.milestone_id != null) await checkMilestone(db, b.milestone_id, projectId);

    const id = await db.tx(async (t) => {
      const ticketNo = b.parent_id == null ? await nextTicketNo(t, projectId) : null;
      const taskId = await t.insert(
        `INSERT INTO tasks (user_id, project_id, parent_id, assignee_id, title, notes, priority, status, status_id, due_at, remind_at, recurrence_rule, completed_at, position, estimate_min, start_at, milestone_id, value, requester_name, requester_email, ticket_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS REAL), (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE user_id = ?)), ?, ?, ?, ?, ?, ?, ?)`,
        me, projectId, b.parent_id ?? null, b.assignee_id ?? null, b.title, b.notes ?? "", b.priority ?? 0, status, statusId,
        b.due_at ?? null, b.remind_at ?? null, b.recurrence ? JSON.stringify(b.recurrence) : null,
        status === "done" ? new Date().toISOString() : null, b.position ?? null, me, b.estimate_min ?? null, b.start_at ?? null, b.milestone_id ?? null,
        b.value ?? null, b.requester_name ?? null, b.requester_email ?? null, ticketNo,
      );
      await setTags(t, me, taskId, b.tags ?? []);
      await logActivity(t, workspaceId, me, "task_created", taskId, { title: b.title });
      if (b.assignee_id != null) {
        await logActivity(t, workspaceId, me, "task_assigned", taskId, { title: b.title, assignee_id: b.assignee_id });
        await notify(t, { userId: b.assignee_id, kind: "assigned", actorId: me, taskId, workspaceId, title: b.title });
      }
      return taskId;
    });
    res.status(201).json(await getTask(me, id));
  });

  app.patch("/api/tasks/:id", auth, async (req, res) => {
    const me = uid(req);
    const b = taskUpdate.parse(req.body);
    const ta = await writableTask(db, me, parseId(req.params.id, "Task not found"));
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
        const pa = await projectAccess(db, me, b.project_id);
        if (!pa) throw new HttpError(400, "Invalid project_id");
        if (!pa.canWrite) throw FORBIDDEN();
        newProject = pa.id;
        newWs = pa.workspaceId;
        if (pa.stage === "archived") throw new HttpError(409, "This project is archived. Restore it to move tasks into it.");
      }
    }

    // The task's status: an explicit status_id wins (and fixes the category); otherwise it follows a category change or a move.
    let newStatusId = current.status_id as number | null;
    if (b.status_id != null) {
      const s = await statusFits(db, b.status_id, newProject, newWs);
      if (b.status !== undefined && b.status !== s.category) throw new HttpError(400, "status and status_id disagree");
      b.status = s.category;
      newStatusId = s.id;
    } else if (b.status_id === null) {
      newStatusId = null;
    } else if (b.status !== undefined || newProject !== current.project_id) {
      newStatusId = await keepOrPick(db, newStatusId, newProject, newWs, (b.status ?? current.status) as "todo" | "doing" | "done");
    }
    const newStart = b.start_at === undefined ? (current.start_at as string | null) : b.start_at;
    checkDates(newStart, b.due_at === undefined ? (current.due_at as string | null) : b.due_at);
    // A milestone belongs to one project, so it is dropped when the task moves to another.
    let newMilestone = b.milestone_id === undefined ? (current.milestone_id as number | null) : b.milestone_id;
    if (newProject !== current.project_id && b.milestone_id === undefined) newMilestone = null;
    if (newMilestone !== null && newMilestone !== current.milestone_id) await checkMilestone(db, newMilestone, newProject);
    const scopeChange = newWs !== ta.workspaceId;
    // Moving work between private and shared (or between workspaces) is for its author, or a workspace admin moving it elsewhere shared.
    if (scopeChange && !(current.user_id === me || (ta.canManage && newWs !== null))) throw FORBIDDEN();

    let newParent = b.parent_id === undefined ? current.parent_id : b.parent_id;
    if (b.parent_id != null) {
      const pa = await taskAccess(db, me, b.parent_id);
      if (!pa || !pa.canWrite) throw new HttpError(400, "Invalid parent_id");
      if (pa.workspaceId !== newWs) throw new HttpError(400, "A subtask must be in the same workspace as its parent");
      if (await isInSubtree(db, b.parent_id, taskId)) throw new HttpError(400, "A task cannot be moved under itself or its own subtasks");
    }
    if (scopeChange && b.parent_id === undefined && current.parent_id !== null) newParent = null; // leaves its parent behind

    const before = await getTask(me, taskId);
    if (b.status === "done" && current.status !== "done" && before.blocked) throw new HttpError(409, "Task is blocked by unfinished tasks");

    let newAssignee = b.assignee_id === undefined ? current.assignee_id : b.assignee_id;
    if (b.assignee_id != null) await assertAssignable(db, newWs, b.assignee_id);
    // An assignee who isn't in the destination workspace can't keep the task.
    if (scopeChange && b.assignee_id === undefined && newAssignee !== null && !(newWs !== null && (await isMemberAtLeast(db, newWs, newAssignee, "member")))) newAssignee = null;

    await db.tx(async (t) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      const set = (col: string, val: unknown) => {
        sets.push(`${col} = ?`);
        args.push(val);
      };
      for (const key of ["title", "notes", "priority", "status", "due_at", "start_at", "position", "estimate_min", "value", "requester_name", "requester_email"] as const) {
        if (b[key] !== undefined) set(key, b[key]);
      }
      if (newProject !== current.project_id) set("project_id", newProject);
      if (newParent !== current.parent_id) set("parent_id", newParent);
      if (newStatusId !== current.status_id) set("status_id", newStatusId);
      if (newMilestone !== current.milestone_id) set("milestone_id", newMilestone);
      // Moving a task into or out of a support project numbers it, or takes its number away.
      if (newProject !== current.project_id) set("ticket_no", current.parent_id === null ? await nextTicketNo(t, newProject) : null);
      // A ticket's first response is the moment someone picks it up.
      if (b.status !== undefined && b.status !== "todo" && current.status === "todo" && current.ticket_no != null && !current.first_response_at) set("first_response_at", new Date().toISOString());
      if (newAssignee !== current.assignee_id) set("assignee_id", newAssignee);
      if (b.remind_at !== undefined) {
        set("remind_at", b.remind_at);
        set("reminded_at", null);
        set("ack", 0);
      }
      if (b.recurrence !== undefined) set("recurrence_rule", b.recurrence ? JSON.stringify(b.recurrence) : null);
      if (b.status !== undefined) set("completed_at", b.status === "done" ? new Date().toISOString() : null);
      if (sets.length) await t.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...args, taskId);
      if (b.tags) await setTags(t, me, taskId, b.tags);

      if (scopeChange) {
        // Subtasks travel with their parent, and nothing may keep a link across the new boundary.
        const family = [taskId, ...(await descendantIds(t, taskId))];
        const m = family.map(() => "?").join(",");
        await t.run(`UPDATE tasks SET project_id = ? WHERE id IN (${m})`, newProject, ...family);
        // Subtasks lose their assignees: those people may not be in the destination.
        await t.run(`UPDATE tasks SET assignee_id = NULL WHERE id IN (${m}) AND id != ?`, ...family, taskId);
        // ...and fall back to the default status of their category, since the statuses differ in the new place.
        await t.run(`UPDATE tasks SET status_id = NULL, milestone_id = NULL WHERE id IN (${m}) AND id != ?`, ...family, taskId);
        const outside = await t.all<{ task_id: number; blocked_by_id: number }>(
          `SELECT d.task_id, d.blocked_by_id FROM task_deps d
           WHERE (d.task_id IN (${m}) AND d.blocked_by_id NOT IN (${m})) OR (d.blocked_by_id IN (${m}) AND d.task_id NOT IN (${m}))`,
          ...family, ...family, ...family, ...family,
        );
        for (const d of outside) await t.run("DELETE FROM task_deps WHERE task_id = ? AND blocked_by_id = ?", d.task_id, d.blocked_by_id);
        // A meeting can only be linked to tasks in its own place, so links don't survive a move across the boundary.
        await t.run(`DELETE FROM meeting_tasks WHERE task_id IN (${m})`, ...family);
        const title = (b.title ?? current.title) as string;
        await logActivity(t, ta.workspaceId, me, "task_moved", taskId, { title, away: true });
        await logActivity(t, newWs, me, "task_moved", taskId, { title });
      }

      const title = (b.title ?? current.title) as string;
      if (b.status !== undefined && b.status !== current.status) {
        if (b.status === "done") await logActivity(t, newWs, me, "task_completed", taskId, { title });
        else if (current.status === "done") await logActivity(t, newWs, me, "task_reopened", taskId, { title });
      }
      if (newAssignee !== current.assignee_id) {
        if (newAssignee === null) await logActivity(t, newWs, me, "task_unassigned", taskId, { title, assignee_id: current.assignee_id });
        else {
          await logActivity(t, newWs, me, "task_assigned", taskId, { title, assignee_id: newAssignee });
          await notify(t, { userId: newAssignee, kind: "assigned", actorId: me, taskId, workspaceId: newWs, title });
        }
      }
    });
    res.json(await getTask(me, taskId));
  });

  app.delete("/api/tasks/:id", auth, async (req, res) => {
    const ta = await readableTask(db, uid(req), parseId(req.params.id, "Task not found"));
    if (!ta.canDelete) throw FORBIDDEN();
    await db.tx(async (t) => {
      await logActivity(t, ta.workspaceId, uid(req), "task_deleted", ta.row.id, { title: ta.row.title });
      await t.run("DELETE FROM tasks WHERE id = ?", ta.row.id);
    });
    res.status(204).end();
  });

  /** Marks a support ticket as answered (stops its first-response clock). */
  app.post("/api/tasks/:id/respond", auth, async (req, res) => {
    const me = uid(req);
    const ta = await writableTask(db, me, parseId(req.params.id, "Task not found"));
    if (ta.row.ticket_no == null) throw new HttpError(409, "Only support tickets have a first response");
    await db.run("UPDATE tasks SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ?", new Date().toISOString(), ta.row.id);
    res.json(await getTask(me, ta.row.id));
  });

  app.post("/api/tasks/:id/complete", auth, async (req, res) => {
    const me = uid(req);
    const ta = await writableTask(db, me, parseId(req.params.id, "Task not found"));
    const task = await getTask(me, ta.row.id);
    if (task.status === "done") throw new HttpError(409, "Task already completed");
    if (task.blocked) throw new HttpError(409, "Task is blocked by unfinished tasks");
    // Optionally completes into a particular "done" status (e.g. "Shipped" rather than the first one).
    const chosen = z.object({ status_id: z.number().int().optional() }).parse(req.body ?? {}).status_id;
    if (chosen !== undefined && (await statusFits(db, chosen, task.project_id, task.workspace_id)).category !== "done") throw new HttpError(400, "That isn't a done status");
    const nextId = await db.tx(async (t) => {
      const doneId = chosen ?? (await keepOrPick(t, task.status_id as number | null, task.project_id, task.workspace_id, "done"));
      await t.run("UPDATE tasks SET status = 'done', status_id = ?, completed_at = ?, first_response_at = COALESCE(first_response_at, CASE WHEN ticket_no IS NULL THEN NULL ELSE CAST(? AS TEXT) END) WHERE id = ?", doneId, new Date().toISOString(), new Date().toISOString(), task.id);
      await logActivity(t, ta.workspaceId, me, "task_completed", task.id, { title: task.title });
      if (!task.recurrence) return null;
      const due = nextOccurrence(task.due_at ?? new Date().toISOString(), task.recurrence);
      const lead = task.remind_at && task.due_at ? Date.parse(task.due_at) - Date.parse(task.remind_at) : null;
      const remind = lead !== null ? new Date(Date.parse(due) - lead).toISOString() : null;
      const spawned = await t.insert(
        `INSERT INTO tasks (user_id, project_id, parent_id, assignee_id, title, notes, priority, status, due_at, remind_at, recurrence_rule, position, estimate_min)
         SELECT user_id, project_id, parent_id, assignee_id, title, notes, priority, 'todo', CAST(? AS TEXT), CAST(? AS TEXT), recurrence_rule, position, estimate_min FROM tasks WHERE id = ?`,
        due, remind, task.id,
      );
      await setTags(t, me, spawned, task.tags);
      // The next occurrence keeps the same lead time between start and due.
      const start = task.start_at && task.due_at ? new Date(Date.parse(task.start_at as string) + (Date.parse(due) - Date.parse(task.due_at))).toISOString() : null;
      await t.run("UPDATE tasks SET status_id = ?, start_at = ? WHERE id = ?", await statusFor(t, task.project_id, task.workspace_id, "todo"), start, spawned);
      return spawned;
    });
    res.json({ completed: await getTask(me, task.id), next: nextId ? await getTask(me, nextId) : null });
  });

  // ---------- reminders (fired, not yet dismissed): for the assignee, or the author when nobody is assigned ----------
  app.get("/api/notifications", auth, async (req, res) => {
    res.json(
      await db.all(
        `SELECT t.id, t.title, t.due_at, t.remind_at FROM tasks t
         WHERE ${visibleTasksSql("t")} AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND t.user_id = ?))
           AND t.status != 'done' AND t.reminded_at IS NOT NULL AND t.ack = 0
         ORDER BY t.remind_at`,
        ...visibleArgs(uid(req)), uid(req), uid(req),
      ),
    );
  });
  app.post("/api/notifications/:id/ack", auth, async (req, res) => {
    const ta = await readableTask(db, uid(req), parseId(req.params.id, "Task not found"));
    await db.run("UPDATE tasks SET ack = 1 WHERE id = ?", ta.row.id);
    res.status(204).end();
  });

  return { getTask, setTags, userName: (id: number) => userName(db, id) };
}
