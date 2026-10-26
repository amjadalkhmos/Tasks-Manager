import type { Health, Stage } from "../api";

export const STAGE_LABEL: Record<Stage, string> = {
  planning: "Planning",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

export const STAGE_ORDER: Stage[] = ["planning", "active", "on_hold", "completed", "archived"];

export const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track" };

/** The button text for moving a project from one stage to another. */
export function transitionLabel(from: Stage, to: Stage): string {
  if (to === "active") return from === "planning" ? "Start project" : from === "on_hold" ? "Resume" : from === "completed" ? "Reopen" : "Restore";
  if (to === "on_hold") return "Put on hold";
  if (to === "completed") return "Mark complete";
  if (to === "archived") return "Archive";
  return STAGE_LABEL[to];
}

/** "2026-03-31" as a local date (a bare Date.parse would read it as UTC and can show the day before). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(day: string | null): string {
  if (!day) return "—";
  return parseDay(day).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Whole days from today to `day` (negative when it has passed). */
export function daysUntil(day: string, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((parseDay(day).getTime() - today.getTime()) / 86_400_000);
}

export function describeDeadline(day: string | null): { text: string; late: boolean } | null {
  if (!day) return null;
  const n = daysUntil(day);
  if (n === 0) return { text: "due today", late: false };
  if (n > 0) return { text: `${n} day${n === 1 ? "" : "s"} left`, late: false };
  return { text: `${-n} day${n === -1 ? "" : "s"} late`, late: true };
}

export const percent = (done: number, total: number) => (total === 0 ? 0 : Math.round((done / total) * 100));
