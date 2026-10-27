import type { Sla, SlaClock, SlaState, Task } from "../api";

const MIN = 60_000;

/** "3h 10m", "2d 4h", "12m": a span of milliseconds, rounded to two units at most. */
export function spanText(ms: number): string {
  const min = Math.max(1, Math.round(Math.abs(ms) / MIN));
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
  const h = Math.round((min % 1440) / 60);
  return `${Math.floor(min / 1440)}d${h ? ` ${h}h` : ""}`;
}

export interface ClockText {
  state: SlaState;
  text: string;
}

/** What a clock says right now, e.g. "Reply due in 2h" or "Resolution overdue by 1d 3h". */
export function clockText(label: "Reply" | "Resolution", c: SlaClock, now = Date.now()): ClockText {
  const left = Date.parse(c.due) - now;
  switch (c.state) {
    case "met": return { state: c.state, text: label === "Reply" ? "Replied in time" : "Resolved in time" };
    case "late": return { state: c.state, text: label === "Reply" ? "Replied late" : "Resolved late" };
    case "breached": return { state: c.state, text: `${label} overdue by ${spanText(left)}` };
    default: return { state: c.state, text: `${label} due in ${spanText(left)}` };
  }
}

const SEVERITY: Record<SlaState, number> = { breached: 4, at_risk: 3, pending: 2, late: 1, met: 0 };

/** The clock that needs looking at first, for a ticket that is still open; null when nothing is running. */
export function urgentClock(task: Pick<Task, "status" | "sla">, now = Date.now()): ClockText | null {
  const sla: Sla | null = task.sla;
  if (!sla || task.status === "done") return null;
  const running = [sla.response && clockText("Reply", sla.response, now), sla.resolution && clockText("Resolution", sla.resolution, now)]
    .filter((c): c is ClockText => !!c)
    .filter((c) => c.state === "breached" || c.state === "at_risk" || c.state === "pending");
  return running.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state])[0] ?? null;
}
