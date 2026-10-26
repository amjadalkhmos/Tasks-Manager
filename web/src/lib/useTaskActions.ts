import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Task } from "../api";

/** Shared task mutations that refresh every task-derived query afterwards. */
export function useTaskActions() {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all(
      ["tasks", "tags", "stats", "timer", "checklist", "meetings", "task-meetings"].map((k) => qc.invalidateQueries({ queryKey: [k] })),
    );

  const complete = useMutation({ mutationFn: api.completeTask, onSuccess: refresh });
  const patch = useMutation({
    mutationFn: ({ id, ...p }: { id: number } & Partial<Omit<Task, "id">>) => api.updateTask(id, p),
    onSuccess: refresh,
  });
  const toggle = (t: Task) => (t.status === "done" ? patch.mutate({ id: t.id, status: "todo" }) : complete.mutate(t.id));

  return {
    refresh,
    complete,
    patch,
    toggle,
    /** Latest error from any of the mutations, for surfacing e.g. "blocked by unfinished tasks". */
    error: (complete.error ?? patch.error)?.message ?? null,
  };
}
