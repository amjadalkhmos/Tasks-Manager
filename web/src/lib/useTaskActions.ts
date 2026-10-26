import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Category, type Status, type Task } from "../api";

/** Shared task mutations that refresh every task-derived query afterwards. */
export function useTaskActions() {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all(
      ["tasks", "tags", "stats", "timer", "checklist", "meetings", "task-meetings", "overview", "portfolio"].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );

  const complete = useMutation({ mutationFn: (id: number) => api.completeTask(id), onSuccess: refresh });
  const patch = useMutation({
    mutationFn: ({ id, ...p }: { id: number } & Partial<Omit<Task, "id">>) => api.updateTask(id, p),
    onSuccess: refresh,
  });
  /** Moves a task to a status: completing it (so recurrence still applies) when the status is a done one. */
  const setStatus = useMutation({
    mutationFn: async ({ task, status, position }: { task: Task; status: Pick<Status, "id" | "category"> | { id: null; category: Category }; position?: number }) => {
      if (status.category === "done") {
        if (task.status !== "done") await api.completeTask(task.id, status.id ?? undefined);
        else if (status.id !== task.status_id) await api.updateTask(task.id, { status_id: status.id });
      } else {
        await api.updateTask(task.id, {
          ...(status.id === null ? { status: status.category, status_id: null } : { status_id: status.id }),
          ...(position !== undefined ? { position } : {}),
        });
      }
    },
    onSuccess: refresh,
  });
  const toggle = (t: Task) => (t.status === "done" ? patch.mutate({ id: t.id, status: "todo" }) : complete.mutate(t.id));

  return {
    refresh,
    complete,
    patch,
    toggle,
    setStatus,
    /** Latest error from any of the mutations, for surfacing e.g. "blocked by unfinished tasks". */
    error: (complete.error ?? patch.error ?? setStatus.error)?.message ?? null,
  };
}
