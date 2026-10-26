import type { Queryable } from "./db.js";
import { HttpError } from "./http-error.js";

/**
 * Who may do what. Every route that touches a task, project or workspace asks this module instead of writing its own
 * `WHERE user_id = ?`, so there is exactly one definition of visibility:
 *
 *   - A project with no workspace is private to the person who made it, and so are the tasks in it (and tasks with no
 *     project at all).
 *   - A project that belongs to a workspace, and every task in it, is visible to the workspace's members, with these roles:
 *       viewer  read only
 *       member  create, edit and comment; delete their own tasks
 *       admin   also delete anyone's tasks, manage projects and invite people
 *       owner   also change roles, transfer ownership and delete the workspace
 *
 * "Not visible" is reported as 404 (so existence isn't revealed); "visible but not allowed" is 403.
 */

export type Role = "owner" | "admin" | "member" | "viewer";

const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
export const atLeast = (role: Role | null | undefined, min: Role): boolean => !!role && RANK[role] >= RANK[min];

export const FORBIDDEN = () => new HttpError(403, "You don't have permission to do that");

export async function roleIn(db: Queryable, workspaceId: number, userId: number): Promise<Role | null> {
  const r = await db.get<{ role: Role }>("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
  return r?.role ?? null;
}

/** The caller's role in a workspace; 404 if they aren't a member, 403 if their role is too low. */
export async function requireRole(db: Queryable, workspaceId: number, userId: number, min: Role): Promise<Role> {
  const role = await roleIn(db, workspaceId, userId);
  if (!role) throw new HttpError(404, "Workspace not found");
  if (!atLeast(role, min)) throw FORBIDDEN();
  return role;
}

export interface ProjectAccess {
  id: number;
  name: string;
  creatorId: number;
  workspaceId: number | null;
  role: Role | null;
  canWrite: boolean;
  canManage: boolean;
}

export async function projectAccess(db: Queryable, userId: number, projectId: number): Promise<ProjectAccess | null> {
  const p = await db.get<{ id: number; name: string; user_id: number; workspace_id: number | null }>(
    "SELECT id, name, user_id, workspace_id FROM projects WHERE id = ?",
    projectId,
  );
  if (!p) return null;
  const base = { id: p.id, name: p.name, creatorId: p.user_id, workspaceId: p.workspace_id };
  if (p.workspace_id === null) {
    return p.user_id === userId ? { ...base, role: null, canWrite: true, canManage: true } : null;
  }
  const role = await roleIn(db, p.workspace_id, userId);
  return role ? { ...base, role, canWrite: atLeast(role, "member"), canManage: atLeast(role, "admin") } : null;
}

export type TaskRow = Record<string, any> & {
  id: number;
  user_id: number;
  project_id: number | null;
  parent_id: number | null;
  assignee_id: number | null;
  title: string;
  status: string;
  recurrence_rule: string | null;
};

export interface TaskAccess {
  row: TaskRow;
  workspaceId: number | null;
  role: Role | null;
  canWrite: boolean;
  canDelete: boolean;
  canManage: boolean;
}

export async function taskAccess(db: Queryable, userId: number, taskId: number): Promise<TaskAccess | null> {
  if (!Number.isSafeInteger(taskId)) return null;
  const row = await db.get<TaskRow & { ws: number | null }>(
    "SELECT t.*, p.workspace_id AS ws FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
    taskId,
  );
  if (!row) return null;
  const { ws, ...task } = row;
  if (ws === null) {
    // Private task: only its creator.
    return task.user_id === userId ? { row: task as TaskRow, workspaceId: null, role: null, canWrite: true, canDelete: true, canManage: true } : null;
  }
  const role = await roleIn(db, ws, userId);
  if (!role) return null;
  return {
    row: task as TaskRow,
    workspaceId: ws,
    role,
    canWrite: atLeast(role, "member"),
    canManage: atLeast(role, "admin"),
    canDelete: atLeast(role, "admin") || (atLeast(role, "member") && task.user_id === userId),
  };
}

/** Task the caller can at least read, else 404. */
export async function readableTask(db: Queryable, userId: number, taskId: number): Promise<TaskAccess> {
  const a = await taskAccess(db, userId, taskId);
  if (!a) throw new HttpError(404, "Task not found");
  return a;
}

/** Task the caller can edit: 404 if invisible, 403 if read-only. */
export async function writableTask(db: Queryable, userId: number, taskId: number): Promise<TaskAccess> {
  const a = await readableTask(db, userId, taskId);
  if (!a.canWrite) throw FORBIDDEN();
  return a;
}

/** SQL (with two `?` placeholders, both the user id) that is true for tasks the user can see. */
export function visibleTasksSql(alias = "t"): string {
  return `((${alias}.user_id = ? AND (${alias}.project_id IS NULL OR ${alias}.project_id IN (SELECT id FROM projects WHERE workspace_id IS NULL)))
    OR ${alias}.project_id IN (SELECT p.id FROM projects p JOIN workspace_members m ON m.workspace_id = p.workspace_id WHERE m.user_id = ?))`;
}
export const visibleArgs = (userId: number): [number, number] => [userId, userId];

/** Tasks that are "mine": ones I made or that are assigned to me, and that I can still see. Four placeholders (all the user id). */
export function myTasksSql(alias = "t"): string {
  return `(${visibleTasksSql(alias)} AND (${alias}.user_id = ? OR ${alias}.assignee_id = ?))`;
}
export const myArgs = (userId: number): number[] => [userId, userId, userId, userId];

export async function isMemberAtLeast(db: Queryable, workspaceId: number, userId: number, min: Role): Promise<boolean> {
  return atLeast(await roleIn(db, workspaceId, userId), min);
}
