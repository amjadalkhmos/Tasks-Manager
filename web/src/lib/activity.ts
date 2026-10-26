import type { ActivityItem } from "../api";

const q = (v: unknown) => `“${String(v ?? "a task")}”`;

/** One line describing what happened, without the actor's name (the UI puts that in front). */
export function describeActivity(a: ActivityItem, nameOf: (id: number | null | undefined) => string): string {
  const d = a.detail;
  switch (a.kind) {
    case "task_created": return `created ${q(d.title)}`;
    case "task_completed": return `completed ${q(d.title)}`;
    case "task_reopened": return `reopened ${q(d.title)}`;
    case "task_assigned": return `assigned ${q(d.title)} to ${nameOf(d.assignee_id as number)}`;
    case "task_unassigned": return `unassigned ${nameOf(d.assignee_id as number)} from ${q(d.title)}`;
    case "task_moved": return d.away ? `moved ${q(d.title)} out of this workspace` : `moved ${q(d.title)} here`;
    case "task_deleted": return `deleted ${q(d.title)}`;
    case "comment_added": return `commented on ${q(d.title)}`;
    case "project_created": return `created the project ${q(d.name)}`;
    case "project_deleted": return `deleted the project ${q(d.name)} and its ${d.tasks ?? 0} task${d.tasks === 1 ? "" : "s"}`;
    case "member_joined": return `joined as ${d.role ?? "a member"}`;
    case "member_left": return "left the workspace";
    case "member_removed": return `removed ${nameOf(d.user_id as number)}`;
    case "role_changed": return `changed ${nameOf(d.user_id as number)} from ${d.from} to ${d.to}`;
    case "meeting_created": return `scheduled the meeting ${q(d.title)}`;
    case "meeting_deleted": return `deleted the meeting ${q(d.title)}`;
    case "meeting_linked": return `linked the meeting ${q(d.title)} to ${q(d.task_title)}`;
    case "meeting_unlinked": return `unlinked the meeting ${q(d.title)} from ${q(d.task_title)}`;
    case "workspace_renamed": return `renamed the workspace from ${q(d.from)} to ${q(d.to)}`;
    default: return a.kind.replace(/_/g, " ");
  }
}
