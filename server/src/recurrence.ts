import { z } from "zod";

export const recurrenceSchema = z.object({
  freq: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(365).default(1),
  weekdays: z.array(z.number().int().min(0).max(6)).optional(), // 0 = Sunday
});
export type Recurrence = z.infer<typeof recurrenceSchema>;

export function parseRule(raw: string | null): Recurrence | null {
  if (!raw) return null;
  try {
    return recurrenceSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Next occurrence strictly after `from` (ISO string in, ISO string out, UTC). */
export function nextOccurrence(from: string, rule: Recurrence): string {
  const d = new Date(from);
  if (rule.freq === "daily") {
    d.setUTCDate(d.getUTCDate() + rule.interval);
  } else if (rule.freq === "weekly") {
    const days = rule.weekdays?.length ? [...rule.weekdays].sort() : [d.getUTCDay()];
    const today = d.getUTCDay();
    const later = days.find((w) => w > today);
    if (later !== undefined) {
      d.setUTCDate(d.getUTCDate() + (later - today));
    } else {
      // jump to the first listed weekday, `interval` weeks later
      d.setUTCDate(d.getUTCDate() + rule.interval * 7 - today + days[0]);
    }
  } else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + rule.interval);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString();
}
