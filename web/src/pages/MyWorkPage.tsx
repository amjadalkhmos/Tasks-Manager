import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { api, type Task } from "../api";
import { EmptyState } from "../components/EmptyState";
import { TaskRow } from "../components/TaskRow";
import { startOfDay } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

type Bucket = "overdue" | "today" | "week" | "later" | "nodate";
const BUCKETS: [Bucket, string][] = [["overdue", "Overdue"], ["today", "Today"], ["week", "This week"], ["later", "Later"], ["nodate", "No date"]];

/** Everything on the signed-in person's plate across all projects, soonest first. */
export function MyWorkPage({ onOpen }: { onOpen: (id: number) => void }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const actions = useTaskActions();

  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const live = new Set((projects.data ?? []).filter((p) => p.stage !== "archived" && p.stage !== "completed").map((p) => p.id));
  // Mine: assigned to me, or private (private tasks are only ever visible to their owner).
  const mine = (tasks.data ?? []).filter(
    (t) => t.status !== "done" && (t.assignee_id === me?.id || t.workspace_id === null) && (t.project_id === null || live.has(t.project_id)),
  );

  const today = startOfDay(new Date()).getTime();
  const bucketOf = (t: Task): Bucket => {
    if (!t.due_at) return "nodate";
    const d = startOfDay(new Date(t.due_at)).getTime();
    if (d < today) return "overdue";
    if (d === today) return "today";
    return d < today + 7 * 86_400_000 ? "week" : "later";
  };
  const byDue = (a: Task, b: Task) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9") || b.priority - a.priority || a.id - b.id;
  const groups = BUCKETS.map(([key, label]) => ({ key, label, items: mine.filter((t) => bucketOf(t) === key).sort(byDue) }));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>My work</h1>
          <p className="sub">{mine.length} open task{mine.length === 1 ? "" : "s"} assigned to you or private to you, across every project.</p>
        </div>
      </header>
      {actions.error && <p className="alert" role="alert">{actions.error}</p>}
      {tasks.data && mine.length === 0 && (
        <EmptyState icon={<CircleCheck size={28} />} title="Nothing on your plate">Tasks assigned to you, and your private tasks, show up here.</EmptyState>
      )}
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="group-label">{g.label} <span className="count">{g.items.length}</span></h2>
          <ul className="tasks">
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={onOpen} onToggle={actions.toggle} project={t.project_id === null ? "Inbox" : projectName.get(t.project_id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

