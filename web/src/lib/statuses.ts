import { useQuery } from "@tanstack/react-query";
import { api, type Category, type Status, type Task } from "../api";

/** What a task can be in: a custom status, or (id null) one of the three built-in ones. */
export interface StatusOption {
  id: number | null;
  name: string;
  color: string;
  category: Category;
}

export const BUILTIN: StatusOption[] = [
  { id: null, name: "To do", color: "#64748b", category: "todo" },
  { id: null, name: "Doing", color: "#2563eb", category: "doing" },
  { id: null, name: "Done", color: "#16a34a", category: "done" },
];

/**
 * The statuses available in a place: the project's own if it has any, else its workspace's, else the built-in three.
 * Mirrors the server's rule (which is the one that counts).
 */
export function statusesFor(all: Status[], projectId: number | null, workspaceId: number | null): StatusOption[] {
  const own = projectId === null ? [] : all.filter((s) => s.project_id === projectId);
  const list = own.length ? own : workspaceId === null ? [] : all.filter((s) => s.workspace_id === workspaceId);
  return list.length ? [...list].sort((a, b) => a.position - b.position || a.id - b.id) : BUILTIN;
}

/** The status a task is shown with; a task without an explicit one shows the first status of its category. */
export function statusOf(options: StatusOption[], task: Pick<Task, "status" | "status_id">): StatusOption {
  return (
    options.find((s) => s.id !== null && s.id === task.status_id) ??
    options.find((s) => s.category === task.status) ??
    BUILTIN.find((s) => s.category === task.status)!
  );
}

export function useStatuses() {
  const q = useQuery({ queryKey: ["statuses"], queryFn: api.statuses, staleTime: 30_000 });
  const all = q.data ?? [];
  return {
    all,
    forPlace: (projectId: number | null, workspaceId: number | null) => statusesFor(all, projectId, workspaceId),
    /** Needs the task's workspace, which tasks carry as `workspace_id`. */
    of: (task: Task) => statusOf(statusesFor(all, task.project_id, task.workspace_id), task),
  };
}
