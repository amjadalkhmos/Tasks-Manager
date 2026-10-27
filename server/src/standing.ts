/**
 * Where a project stands, worked out from its tasks and milestones. Pure functions, so the rules can be tested directly
 * and the project overview, the portfolio and the attention list all agree.
 */

/** A task with no estimate counts as this long when weighing progress, so unestimated work still moves the bar. */
export const DEFAULT_TASK_MIN = 60;

export type Health = "on_track" | "at_risk" | "off_track";

export interface TaskLite {
  status: string;
  due_at: string | null;
  estimate_min: number | null;
  milestone_id: number | null;
}

export interface MilestoneLite {
  id: number;
  name: string;
  due_date: string | null;
  completed_at: string | null;
}

export interface ProjectLite {
  stage: string;
  start_date: string | null;
  target_date: string | null;
}

export interface MilestoneStanding extends MilestoneLite {
  tasks_total: number;
  tasks_done: number;
  /** Open tasks that are overdue, or scheduled to finish after the milestone's date. */
  tasks_late: number;
  /** The milestone's date has passed and it isn't done. */
  overdue: boolean;
}

export interface Signal {
  code: "overdue_tasks" | "target_passed" | "milestone_overdue" | "milestone_slipping" | "behind_schedule";
  text: string;
}

export interface Standing {
  tasks_total: number;
  tasks_done: number;
  tasks_doing: number;
  tasks_overdue: number;
  /** Done work as a share of all work, weighted by estimate. 0 to 100. */
  progress_pct: number;
  milestones_total: number;
  milestones_done: number;
  next_milestone: { name: string; due_date: string | null } | null;
  milestones: MilestoneStanding[];
  signals: Signal[];
  /** What the numbers suggest; null when the project isn't active. The team's own rating is kept separately. */
  suggested_health: Health | null;
}

const weight = (t: TaskLite) => (t.estimate_min && t.estimate_min > 0 ? t.estimate_min : DEFAULT_TASK_MIN);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function standing(project: ProjectLite, tasks: TaskLite[], milestones: MilestoneLite[], now = new Date()): Standing {
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const open = tasks.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => t.due_at !== null && t.due_at < nowIso);

  const totalWeight = tasks.reduce((n, t) => n + weight(t), 0);
  const doneWeight = tasks.filter((t) => t.status === "done").reduce((n, t) => n + weight(t), 0);
  const progress = totalWeight === 0 ? 0 : Math.round((doneWeight / totalWeight) * 100);

  const ms: MilestoneStanding[] = milestones.map((m) => {
    const mine = tasks.filter((t) => t.milestone_id === m.id);
    const late = mine.filter((t) => t.status !== "done" && t.due_at !== null && (t.due_at < nowIso || (m.due_date !== null && t.due_at.slice(0, 10) > m.due_date)));
    return {
      ...m,
      tasks_total: mine.length,
      tasks_done: mine.filter((t) => t.status === "done").length,
      tasks_late: late.length,
      overdue: m.completed_at === null && m.due_date !== null && m.due_date < today,
    };
  });
  const openMs = ms.filter((m) => m.completed_at === null);
  const next = openMs.filter((m) => m.due_date !== null).sort((a, b) => a.due_date!.localeCompare(b.due_date!))[0];

  const signals: Signal[] = [];
  let suggested: Health | null = null;
  if (project.stage === "active") {
    let severe = false;
    if (overdue.length) signals.push({ code: "overdue_tasks", text: `${plural(overdue.length, "task")} overdue` });
    if (project.target_date && project.target_date < today && open.length) {
      severe = true;
      signals.push({ code: "target_passed", text: `The target date has passed with ${plural(open.length, "task")} still open` });
    }
    const lateMs = openMs.filter((m) => m.overdue);
    if (lateMs.length) {
      signals.push({ code: "milestone_overdue", text: lateMs.length === 1 ? `Milestone “${lateMs[0].name}” is overdue` : `${lateMs.length} milestones are overdue` });
    }
    const slipping = openMs.filter((m) => !m.overdue && m.tasks_late > 0);
    if (slipping.length) {
      signals.push({ code: "milestone_slipping", text: slipping.length === 1 ? `Work for “${slipping[0].name}” is running behind` : `Work for ${slipping.length} milestones is running behind` });
    }
    if (project.start_date && project.target_date && project.target_date > project.start_date && project.target_date >= today) {
      const span = Date.parse(project.target_date) - Date.parse(project.start_date);
      const elapsed = Math.min(1, Math.max(0, (Date.parse(today) - Date.parse(project.start_date)) / span));
      const gap = elapsed * 100 - progress;
      if (elapsed > 0.1 && gap > 15) {
        if (gap > 30) severe = true;
        signals.push({ code: "behind_schedule", text: `${Math.round(elapsed * 100)}% of the time has gone, but ${progress}% of the work is done` });
      }
    }
    suggested = severe ? "off_track" : signals.length ? "at_risk" : "on_track";
  }

  return {
    tasks_total: tasks.length,
    tasks_done: tasks.filter((t) => t.status === "done").length,
    tasks_doing: tasks.filter((t) => t.status === "doing").length,
    tasks_overdue: overdue.length,
    progress_pct: progress,
    milestones_total: ms.length,
    milestones_done: ms.length - openMs.length,
    next_milestone: next ? { name: next.name, due_date: next.due_date } : null,
    milestones: ms,
    signals,
    suggested_health: suggested,
  };
}
