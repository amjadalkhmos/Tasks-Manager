import type { Queryable } from "./db.js";
import { displayName } from "./dialect.js";

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
export async function logActivity(
  db: Queryable,
  workspaceId: number | null,
  userId: number,
  kind: ActivityKind,
  taskId: number | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  if (workspaceId === null) return;
  await db.run("INSERT INTO activity (workspace_id, task_id, user_id, kind, detail_json) VALUES (?, ?, ?, ?, ?)", workspaceId, taskId, userId, kind, JSON.stringify(detail));
}

/** Tells someone about something. Nobody is notified about their own actions. */
export async function notify(
  db: Queryable,
  a: { userId: number; kind: AlertKind; actorId: number; taskId?: number | null; workspaceId?: number | null; title?: string },
): Promise<void> {
  if (a.userId === a.actorId) return;
  await db.run(
    "INSERT INTO alerts (user_id, kind, actor_id, task_id, workspace_id, title) VALUES (?, ?, ?, ?, ?, ?)",
    a.userId, a.kind, a.actorId, a.taskId ?? null, a.workspaceId ?? null, (a.title ?? "").slice(0, 200),
  );
}

export async function userName(db: Queryable, userId: number): Promise<string> {
  const r = await db.get<{ name: string }>(`SELECT ${displayName(db.dialect, "u")} AS name FROM users u WHERE u.id = ?`, userId);
  return r?.name ?? "Someone";
}
