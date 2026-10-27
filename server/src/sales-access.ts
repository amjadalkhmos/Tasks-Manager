import { atLeast, roleIn, type Role } from "./access.js";
import type { Queryable } from "./db.js";
import { marks } from "./db.js";
import { HttpError } from "./http-error.js";

/**
 * Who may see and work on which sales records. Records (leads, accounts, contacts, deals) each have an owner, and access
 * is granted by owner:
 *
 *   - A workspace owner or admin sees and edits everything, and manages the grants.
 *   - Anyone else sees Sales only when an admin has switched it on for them. They then always have their own records, and
 *     whatever other owners were granted to them, each as "view" or "edit". Records with no owner are "unassigned" and
 *     are a grant of their own.
 *   - A workspace viewer never gets more than "view".
 *
 * "Can't see it" is reported as 404 (so existence isn't revealed); "can see but not change" as 403.
 */

export type Level = "view" | "edit";

export interface SalesScope {
  workspaceId: number;
  userId: number;
  role: Role;
  manager: boolean;
  enabled: boolean;
  owners: Map<number, Level>;
  unassigned: Level | null;
}

export async function salesScope(db: Queryable, workspaceId: number, userId: number): Promise<SalesScope | null> {
  const role = await roleIn(db, workspaceId, userId);
  if (!role) return null;
  const manager = atLeast(role, "admin");
  const rows = await db.all<{ owner_id: number | null; level: Level }>("SELECT owner_id, level FROM sales_access WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
  const cap = (l: Level): Level => (role === "viewer" ? "view" : l);
  const owners = new Map<number, Level>();
  let unassigned: Level | null = null;
  for (const r of rows) {
    if (r.owner_id === null) unassigned = cap(r.level);
    else owners.set(r.owner_id, cap(r.level));
  }
  const enabled = manager || rows.length > 0;
  if (enabled) owners.set(userId, cap("edit"));
  return { workspaceId, userId, role, manager, enabled, owners, unassigned };
}

/** The caller's scope in a workspace: 404 if they aren't a member, 403 if Sales isn't switched on for them. */
export async function requireSales(db: Queryable, workspaceId: number, userId: number): Promise<SalesScope> {
  const s = await salesScope(db, workspaceId, userId);
  if (!s) throw new HttpError(404, "Workspace not found");
  if (!s.enabled) throw new HttpError(403, "You don't have access to Sales");
  return s;
}

export const canView = (s: SalesScope, owner: number | null): boolean => s.manager || (owner === null ? s.unassigned !== null : s.owners.has(owner));
export const canEdit = (s: SalesScope, owner: number | null): boolean => s.manager || (owner === null ? s.unassigned === "edit" : s.owners.get(owner) === "edit");

/** SQL (and its arguments) that is true for rows in `col` the scope can see. */
export function visibleOwners(s: SalesScope, col: string): { sql: string; args: number[] } {
  if (s.manager) return { sql: "1 = 1", args: [] };
  const ids = [...s.owners.keys()];
  const parts: string[] = [];
  if (ids.length) parts.push(`${col} IN (${marks(ids.length)})`);
  if (s.unassigned !== null) parts.push(`${col} IS NULL`);
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "1 = 0", args: ids };
}

/** Owners the scope may hand records to: those it can edit (and, for managers, any member). */
export function assignableOwners(s: SalesScope): { ids: number[]; unassigned: boolean } {
  return { ids: [...s.owners].filter(([, l]) => l === "edit").map(([id]) => id), unassigned: s.manager || s.unassigned === "edit" };
}

/** Reading a record that is invisible is "not found"; one that is visible but read-only is "forbidden". */
export function needView(s: SalesScope, owner: number | null, what: string): void {
  if (!canView(s, owner)) throw new HttpError(404, `${what} not found`);
}
export function needEdit(s: SalesScope, owner: number | null, what: string): void {
  needView(s, owner, what);
  if (!canEdit(s, owner)) throw new HttpError(403, "You don't have permission to change that");
}

/**
 * Whether `owner` is a valid new owner for a record the caller is changing: a workspace member (or nobody) that the
 * caller may edit. Leaving the owner as it is always passes.
 */
export async function checkOwner(db: Queryable, s: SalesScope, owner: number | null, current?: number | null): Promise<void> {
  if (current !== undefined && owner === current) return;
  if (owner !== null && !(await roleIn(db, s.workspaceId, owner))) throw new HttpError(400, "That person isn't in this workspace");
  if (!canEdit(s, owner)) throw new HttpError(403, "You can only assign records to people you have edit access to");
}
