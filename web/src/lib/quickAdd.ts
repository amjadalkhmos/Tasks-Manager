import * as chrono from "chrono-node";
import type { Recurrence } from "../api";

export interface QuickAdd {
  title: string;
  priority: number;
  tags: string[];
  due_at: string | null;
  recurrence: Recurrence | null;
  /** Project name typed as `@name`; the caller resolves it to an id. */
  project: string | null;
}

const PRIORITY_WORDS: Record<string, number> = { low: 1, l: 1, "1": 1, med: 2, medium: 2, m: 2, "2": 2, high: 3, h: 3, "3": 3 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const RECURRENCE = new RegExp(
  `\\bevery\\s+(?:(\\d+)\\s+)?(day|days|week|weeks|month|months|${WEEKDAYS.join("|")})\\b|\\b(daily|weekly|monthly)\\b`,
  "i",
);

function parseRecurrence(m: RegExpMatchArray): Recurrence {
  const word = (m[2] ?? m[3] ?? "").toLowerCase();
  const interval = m[1] ? Math.max(1, Number(m[1])) : 1;
  const wd = WEEKDAYS.indexOf(word);
  if (wd >= 0) return { freq: "weekly", interval: 1, weekdays: [wd] };
  if (word.startsWith("day") || word === "daily") return { freq: "daily", interval };
  if (word.startsWith("week")) return { freq: "weekly", interval };
  return { freq: "monthly", interval };
}

/**
 * Parses one line like "Call Sam tomorrow 3pm !high #work @Home every week".
 * Anything not recognised stays in the title.
 */
export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  let text = input;
  let priority = 0;
  let project: string | null = null;
  let recurrence: Recurrence | null = null;
  const tags: string[] = [];

  text = text.replace(/(^|\s)!(\w+)(?=\s|$)/g, (all, pre: string, word: string) => {
    const p = PRIORITY_WORDS[word.toLowerCase()];
    if (p === undefined) return all;
    priority = p;
    return pre;
  });
  text = text.replace(/(^|\s)#([\w-]+)(?=\s|$)/g, (_all, pre: string, tag: string) => {
    tags.push(tag.toLowerCase());
    return pre;
  });
  text = text.replace(/(^|\s)@([\w-]+)(?=\s|$)/g, (_all, pre: string, name: string) => {
    project = name;
    return pre;
  });

  const rec = text.match(RECURRENCE);
  if (rec) {
    recurrence = parseRecurrence(rec);
    text = text.replace(rec[0], " ");
  }

  // forwardDate: "friday" means the next Friday, never one in the past.
  // A bare weekday used for recurrence ("every monday") has been stripped above, so it won't double as a due date.
  let due_at: string | null = null;
  const found = chrono.parse(text, now, { forwardDate: true })[0];
  if (found) {
    const start = found.start;
    const date = start.date();
    // Date without a time → leave at local midnight, which the UI displays as date-only.
    if (!start.isCertain("hour")) date.setHours(0, 0, 0, 0);
    due_at = date.toISOString();
    text = text.replace(found.text, " ");
  } else if (recurrence) {
    // "water plants every week" with no explicit date: first occurrence is today.
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    due_at = d.toISOString();
  }

  const title = text.replace(/\s+/g, " ").trim();
  return { title: title || input.trim(), priority, tags: [...new Set(tags)], due_at, recurrence, project };
}
