import type { FilterQuery, Recurrence, Task } from "../api";

export const PRIORITY = ["None", "Low", "Medium", "High"];

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const isOverdue = (t: Task) => t.status !== "done" && !!t.due_at && new Date(t.due_at) < new Date();

export function formatDue(iso: string): string {
  const d = new Date(iso);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(hasTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** created_at is SQLite's zone-less UTC timestamp. */
export const createdAtMs = (t: Task) => Date.parse(`${t.created_at.replace(" ", "T")}Z`);

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h}h`;
}

/** Client-side equivalent of the server's GET /tasks filters, used for ad-hoc and saved filters. */
export function applyQuery(tasks: Task[], q: FilterQuery): Task[] {
  const text = String(q.q ?? "").toLowerCase();
  return tasks.filter((t) => {
    if (q.project_id !== undefined && q.project_id !== "" && t.project_id !== Number(q.project_id)) return false;
    if (q.tag && !t.tags.includes(String(q.tag).toLowerCase())) return false;
    if (q.priority !== undefined && q.priority !== "" && t.priority !== Number(q.priority)) return false;
    if (q.status === "open" ? t.status === "done" : q.status && t.status !== q.status) return false;
    if (text && !t.title.toLowerCase().includes(text) && !t.notes.toLowerCase().includes(text)) return false;
    if (q.due_before && (!t.due_at || t.due_at > String(q.due_before))) return false;
    if (q.due_after && (!t.due_at || t.due_at < String(q.due_after))) return false;
    return true;
  });
}

/** Insert point between two neighbours for drag-and-drop ordering. */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeRecurrence(r: Recurrence): string {
  const unit = { daily: "day", weekly: "week", monthly: "month" }[r.freq];
  const base = r.interval === 1 ? `Every ${unit}` : `Every ${r.interval} ${unit}s`;
  return r.freq === "weekly" && r.weekdays?.length ? `${base} on ${r.weekdays.map((d) => WEEKDAY_NAMES[d]).join(", ")}` : base;
}

export type DueState = "overdue" | "today" | "later";

export function dueState(t: Task): DueState {
  if (!t.due_at || t.status === "done") return "later";
  const due = new Date(t.due_at);
  if (due < new Date() && (due.getHours() !== 0 || due.getMinutes() !== 0 || startOfDay(due) < startOfDay(new Date()))) return "overdue";
  return startOfDay(due).getTime() === startOfDay(new Date()).getTime() ? "today" : "later";
}

export interface TaskGroup {
  key: string;
  label: string | null;
  danger?: boolean;
  tasks: Task[];
}

const dayLabel = (d: Date) => {
  const today = startOfDay(new Date());
  const diff = Math.round((startOfDay(d).getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};

/** Splits a view's tasks into labelled sections: Overdue/Today, per-day for Upcoming, and a trailing Completed. */
export function groupTasks(view: string, tasks: Task[]): TaskGroup[] {
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  const groups: TaskGroup[] = [];

  if (view === "today") {
    const overdue = open.filter((t) => dueState(t) === "overdue" && startOfDay(new Date(t.due_at!)) < startOfDay(new Date()));
    const rest = open.filter((t) => !overdue.includes(t));
    if (overdue.length) groups.push({ key: "overdue", label: "Overdue", danger: true, tasks: overdue });
    if (rest.length) groups.push({ key: "today", label: "Today", tasks: rest });
  } else if (view === "upcoming") {
    const byDay = new Map<number, Task[]>();
    for (const t of open) {
      const k = startOfDay(new Date(t.due_at!)).getTime();
      byDay.set(k, [...(byDay.get(k) ?? []), t]);
    }
    for (const [k, list] of [...byDay].sort((a, b) => a[0] - b[0])) groups.push({ key: String(k), label: dayLabel(new Date(k)), tasks: list });
  } else if (open.length) {
    groups.push({ key: "open", label: null, tasks: open });
  }
  if (done.length) groups.push({ key: "done", label: "Completed", tasks: done });
  return groups;
}
