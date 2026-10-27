import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { FORBIDDEN, atLeast, projectAccess, roleIn } from "./access.js";
import type { DB, Queryable } from "./db.js";
import { HttpError, parseId } from "./http-error.js";

export type Category = "todo" | "doing" | "done";

export interface StatusRow {
  id: number;
  workspace_id: number | null;
  project_id: number | null;
  name: string;
  category: Category;
  color: string;
  position: number;
}

export const PROJECT_TYPES = ["delivery", "pipeline", "initiative", "support"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/** The statuses a new project of each type starts with. An initiative uses the built-in To do / Doing / Done. */
export const TYPE_STATUSES: Record<ProjectType, { name: string; category: Category; color: string }[]> = {
  delivery: [
    { name: "To do", category: "todo", color: "#64748b" },
    { name: "Doing", category: "doing", color: "#2563eb" },
    { name: "Review", category: "doing", color: "#a855f7" },
    { name: "Done", category: "done", color: "#16a34a" },
  ],
  pipeline: [
    { name: "New", category: "todo", color: "#64748b" },
    { name: "Contacted", category: "doing", color: "#2563eb" },
    { name: "Qualified", category: "doing", color: "#a855f7" },
    { name: "Won", category: "done", color: "#16a34a" },
    { name: "Lost", category: "done", color: "#dc2626" },
  ],
  initiative: [],
  support: [
    { name: "New", category: "todo", color: "#64748b" },
    { name: "In progress", category: "doing", color: "#2563eb" },
    { name: "Waiting on customer", category: "doing", color: "#f59e0b" },
    { name: "Resolved", category: "done", color: "#16a34a" },
  ],
};

export async function seedProjectStatuses(q: Queryable, projectId: number, type: ProjectType): Promise<void> {
  for (const [i, s] of TYPE_STATUSES[type].entries()) {
    await q.run("INSERT INTO statuses (workspace_id, project_id, name, category, color, position) VALUES (NULL, ?, ?, ?, ?, ?)", projectId, s.name, s.category, s.color, i);
  }
}

const COLS = "id, workspace_id, project_id, name, category, color, position";

/** What a scope starts with when its owners choose to customise: the same three steps everyone already has. */
const DEFAULTS: { name: string; category: Category; color: string }[] = [
  { name: "To do", category: "todo", color: "#64748b" },
  { name: "Doing", category: "doing", color: "#2563eb" },
  { name: "Done", category: "done", color: "#16a34a" },
];

/**
 * The statuses a task in this place can have: the project's own if it defines any, else its workspace's, else none
 * (meaning the built-in To do / Doing / Done, which need no rows).
 */
export async function effectiveStatuses(q: Queryable, projectId: number | null, workspaceId: number | null): Promise<StatusRow[]> {
  if (projectId !== null) {
    const own = await q.all<StatusRow>(`SELECT ${COLS} FROM statuses WHERE project_id = ? ORDER BY position, id`, projectId);
    if (own.length) return own;
  }
  if (workspaceId !== null) return q.all<StatusRow>(`SELECT ${COLS} FROM statuses WHERE workspace_id = ? ORDER BY position, id`, workspaceId);
  return [];
}

/** The status a task of this category should have here: the first one defined for it, or null for the built-in. */
export async function statusFor(q: Queryable, projectId: number | null, workspaceId: number | null, category: Category): Promise<number | null> {
  return (await effectiveStatuses(q, projectId, workspaceId)).find((s) => s.category === category)?.id ?? null;
}

/** Keeps the task's current status when it is still valid for the category in its (new) place, else picks the default one. */
export async function keepOrPick(
  q: Queryable, current: number | null, projectId: number | null, workspaceId: number | null, category: Category,
): Promise<number | null> {
  const all = await effectiveStatuses(q, projectId, workspaceId);
  if (current !== null && all.some((s) => s.id === current && s.category === category)) return current;
  return all.find((s) => s.category === category)?.id ?? null;
}

/** A status the caller picked for a task: it must be one of the statuses available where the task lives. */
export async function statusFits(q: Queryable, statusId: number, projectId: number | null, workspaceId: number | null): Promise<StatusRow> {
  const s = (await effectiveStatuses(q, projectId, workspaceId)).find((x) => x.id === statusId);
  if (!s) throw new HttpError(400, "That status isn't available for this task");
  return s;
}

const scopeBody = z
  .object({ project_id: z.number().int().optional(), workspace_id: z.number().int().optional() })
  .refine((v) => (v.project_id === undefined) !== (v.workspace_id === undefined), "Give either project_id or workspace_id");

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const nameField = z.string().trim().min(1).max(40);
const createBody = z.intersection(scopeBody, z.object({ name: nameField, category: z.enum(["todo", "doing", "done"]), color: color.optional() }));
const updateBody = z.object({ name: nameField, color, position: z.number().int().min(0).max(1000) }).partial();

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

export function registerStatuses(app: Express, { db, auth, uid }: Deps) {
  /** Statuses are managed by whoever manages the place: a private project's owner, a workspace's admins. */
  async function manageScope(userId: number, scope: { project_id?: number | null; workspace_id?: number | null }) {
    if (scope.project_id != null) {
      const pa = await projectAccess(db, userId, scope.project_id);
      if (!pa) throw new HttpError(404, "Project not found");
      if (pa.workspaceId !== null && !pa.canManage) throw FORBIDDEN();
      return { project: pa.id, workspace: null as number | null };
    }
    const ws = scope.workspace_id!;
    const role = await roleIn(db, ws, userId);
    if (!role) throw new HttpError(404, "Workspace not found");
    if (!atLeast(role, "admin")) throw FORBIDDEN();
    return { project: null as number | null, workspace: ws };
  }

  const scopeRows = (q: Queryable, s: { project: number | null; workspace: number | null }) =>
    s.project !== null
      ? q.all<StatusRow>(`SELECT ${COLS} FROM statuses WHERE project_id = ? ORDER BY position, id`, s.project)
      : q.all<StatusRow>(`SELECT ${COLS} FROM statuses WHERE workspace_id = ? ORDER BY position, id`, s.workspace);

  const seed = async (q: Queryable, s: { project: number | null; workspace: number | null }) => {
    for (const [i, d] of DEFAULTS.entries()) {
      await q.run("INSERT INTO statuses (workspace_id, project_id, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)", s.workspace, s.project, d.name, d.category, d.color, i);
    }
  };

  /** Every custom status the caller can see, for the whole app to resolve names and colours from. */
  app.get("/api/statuses", auth, async (req, res) => {
    const me = uid(req);
    res.json(
      await db.all<StatusRow>(
        `SELECT s.id, s.workspace_id, s.project_id, s.name, s.category, s.color, s.position FROM statuses s
         WHERE s.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)
            OR s.project_id IN (SELECT id FROM projects WHERE (workspace_id IS NULL AND user_id = ?)
                                   OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))
         ORDER BY s.position, s.id`,
        me, me, me,
      ),
    );
  });

  app.post("/api/statuses/defaults", auth, async (req, res) => {
    const scope = await manageScope(uid(req), scopeBody.parse(req.body));
    await db.tx(async (t) => {
      if ((await scopeRows(t, scope)).length) throw new HttpError(409, "This already has its own statuses");
      await seed(t, scope);
    });
    res.status(201).json(await scopeRows(db, scope));
  });

  app.post("/api/statuses", auth, async (req, res) => {
    const b = createBody.parse(req.body);
    const scope = await manageScope(uid(req), b);
    const id = await db.tx(async (t) => {
      // A scope with custom statuses needs at least a To do and a Done, so the first custom one brings the defaults along.
      if (!(await scopeRows(t, scope)).length) await seed(t, scope);
      const rows = await scopeRows(t, scope);
      if (rows.some((r) => r.name.toLowerCase() === b.name.toLowerCase())) throw new HttpError(409, "There is already a status with that name");
      const next = Math.max(-1, ...rows.map((r) => r.position)) + 1;
      return t.insert(
        "INSERT INTO statuses (workspace_id, project_id, name, category, color, position) VALUES (?, ?, ?, ?, ?, ?)",
        scope.workspace, scope.project, b.name, b.category, b.color ?? DEFAULTS.find((d) => d.category === b.category)!.color, next,
      );
    });
    res.status(201).json(await db.get(`SELECT ${COLS} FROM statuses WHERE id = ?`, id));
  });

  const loadStatus = async (id: number) => {
    const s = await db.get<StatusRow>(`SELECT ${COLS} FROM statuses WHERE id = ?`, id);
    if (!s) throw new HttpError(404, "Status not found");
    return s;
  };
  const asScope = (s: StatusRow) => ({ project_id: s.project_id, workspace_id: s.workspace_id });

  app.patch("/api/statuses/:id", auth, async (req, res) => {
    const b = updateBody.parse(req.body);
    const s = await loadStatus(parseId(req.params.id, "Status not found"));
    const scope = await manageScope(uid(req), asScope(s));
    if (b.name !== undefined) {
      const clash = (await scopeRows(db, scope)).some((r) => r.id !== s.id && r.name.toLowerCase() === b.name!.toLowerCase());
      if (clash) throw new HttpError(409, "There is already a status with that name");
    }
    // The category is fixed: changing it would silently complete or reopen every task that has the status.
    await db.run("UPDATE statuses SET name = COALESCE(?, name), color = COALESCE(?, color), position = COALESCE(?, position) WHERE id = ?", b.name ?? null, b.color ?? null, b.position ?? null, s.id);
    res.json(await loadStatus(s.id));
  });

  app.delete("/api/statuses/:id", auth, async (req, res) => {
    const s = await loadStatus(parseId(req.params.id, "Status not found"));
    const scope = await manageScope(uid(req), asScope(s));
    await db.tx(async (t) => {
      const siblings = (await scopeRows(t, scope)).filter((r) => r.id !== s.id);
      const sameCategory = siblings.find((r) => r.category === s.category);
      if (!sameCategory && s.category !== "doing") throw new HttpError(409, `Keep at least one ${s.category === "todo" ? "To do" : "Done"} status`);
      if (sameCategory) {
        await t.run("UPDATE tasks SET status_id = ? WHERE status_id = ?", sameCategory.id, s.id);
      } else {
        // The last "doing" status: its tasks go back to To do.
        await t.run("UPDATE tasks SET status = 'todo', completed_at = NULL, status_id = ? WHERE status_id = ?", siblings.find((r) => r.category === "todo")!.id, s.id);
      }
      await t.run("DELETE FROM statuses WHERE id = ?", s.id);
    });
    res.status(204).end();
  });

  /** Back to the built-in statuses: removes the custom ones; tasks keep their category (to do / doing / done). */
  app.delete("/api/statuses", auth, async (req, res) => {
    const q = z.object({ project_id: z.coerce.number().int().optional(), workspace_id: z.coerce.number().int().optional() }).pipe(scopeBody).parse(req.query);
    const scope = await manageScope(uid(req), q);
    await db.run(scope.project !== null ? "DELETE FROM statuses WHERE project_id = ?" : "DELETE FROM statuses WHERE workspace_id = ?", scope.project ?? scope.workspace);
    res.status(204).end();
  });
}
