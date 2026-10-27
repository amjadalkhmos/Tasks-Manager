/**
 * Service targets for support tickets: how long a customer may wait for a first response and for a resolution.
 * Pure functions, shared by the task API, the project overview and the tests.
 */

export type SlaState = "met" | "late" | "pending" | "at_risk" | "breached";

export interface SlaClock {
  /** When the target falls due (ISO). */
  due: string;
  state: SlaState;
}

export interface Sla {
  response: SlaClock | null;
  resolution: SlaClock | null;
}

export interface Targets {
  first_response_hours: number | null;
  resolution_hours: number | null;
}

export interface TicketTimes {
  /** Either the database's "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO timestamp. */
  created_at: string;
  first_response_at: string | null;
  completed_at: string | null;
  status: string;
}

/** The database stores some timestamps as "YYYY-MM-DD HH:MM:SS" in UTC; those need a "T" and a "Z" to parse as UTC. */
export function parseStamp(ts: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts);
}

/** A pending clock turns "at risk" once less than this share of its time is left. */
const AT_RISK_SHARE = 0.25;

function clock(start: number, hours: number, doneAt: number | null, now: number): SlaClock {
  const due = start + hours * 3_600_000;
  let state: SlaState;
  if (doneAt !== null) state = doneAt <= due ? "met" : "late";
  else if (now > due) state = "breached";
  else state = due - now < (due - start) * AT_RISK_SHARE ? "at_risk" : "pending";
  return { due: new Date(due).toISOString(), state };
}

export function sla(t: TicketTimes, targets: Targets, now = new Date()): Sla | null {
  if (!targets.first_response_hours && !targets.resolution_hours) return null;
  const start = parseStamp(t.created_at);
  const n = now.getTime();
  return {
    response: targets.first_response_hours ? clock(start, targets.first_response_hours, t.first_response_at ? parseStamp(t.first_response_at) : null, n) : null,
    resolution: targets.resolution_hours ? clock(start, targets.resolution_hours, t.status === "done" && t.completed_at ? parseStamp(t.completed_at) : null, n) : null,
  };
}

/** Whole minutes between two stamps, never negative. */
export const minutesBetween = (from: string, to: string) => Math.max(0, Math.round((parseStamp(to) - parseStamp(from)) / 60_000));
