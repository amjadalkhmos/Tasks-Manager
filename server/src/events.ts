import type { DB } from "./db.js";

export type ActivityKind =
  | "task_created"
  | "task_completed"
  | "task_reopened"
  | "task_assigned"
  | "task_unassigned"
  | "task_moved"
  | "task_deleted"
  | "comment_added"
  | "project_created"
  | "project_deleted"
  | "member_joined"
  | "member_left"
  | "member_removed"
  | "role_changed"
  | "workspace_renamed";

export type AlertKind = "assigned" | "mentioned" | "commented" | "invite_accepted" | "removed";

/** Records something that happened in a workspace. Personal (no workspace) activity is not logged. */
export function logActivity(
  db: DB,
  workspaceId: number | null,
  userId: number,
  kind: ActivityKind,
  taskId: number | null,
  detail: Record<string, unknown> = {},
) {
  if (workspaceId === null) return;
  db.prepare("INSERT INTO activity (workspace_id, task_id, user_id, kind, detail_json) VALUES (?, ?, ?, ?, ?)").run(
    workspaceId, taskId, userId, kind, JSON.stringify(detail),
  );
}

/** Tells someone about something. Nobody is notified about their own actions. */
export function notify(
  db: DB,
  a: { userId: number; kind: AlertKind; actorId: number; taskId?: number | null; workspaceId?: number | null; title?: string },
) {
  if (a.userId === a.actorId) return;
  db.prepare("INSERT INTO alerts (user_id, kind, actor_id, task_id, workspace_id, title) VALUES (?, ?, ?, ?, ?, ?)").run(
    a.userId, a.kind, a.actorId, a.taskId ?? null, a.workspaceId ?? null, (a.title ?? "").slice(0, 200),
  );
}

/** Display name: the chosen name, else the part of the email before the @. */
export const displayNameSql = (alias = "u") => `COALESCE(NULLIF(TRIM(${alias}.name), ''), substr(${alias}.email, 1, instr(${alias}.email, '@') - 1))`;

export function userName(db: DB, userId: number): string {
  const r = db.prepare(`SELECT ${displayNameSql("u")} AS name FROM users u WHERE u.id = ?`).get(userId) as { name: string } | undefined;
  return r?.name ?? "Someone";
}
