import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "./quickAdd";

// Wednesday 2026-03-04, noon local time.
const NOW = new Date(2026, 2, 4, 12, 0, 0);

describe("parseQuickAdd", () => {
  it("extracts priority, tags, project, date and time while keeping the title", () => {
    const r = parseQuickAdd("Call Sam tomorrow 3pm !high #Work @Home", NOW);
    expect(r.title).toBe("Call Sam");
    expect(r.priority).toBe(3);
    expect(r.tags).toEqual(["work"]);
    expect(r.project).toBe("Home");
    const due = new Date(r.due_at!);
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()]).toEqual([2026, 2, 5, 15]);
  });

  it("leaves date-only dues at local midnight", () => {
    const due = new Date(parseQuickAdd("Pay rent on march 10", NOW).due_at!);
    expect([due.getMonth(), due.getDate(), due.getHours(), due.getMinutes()]).toEqual([2, 10, 0, 0]);
  });

  it("parses recurrence and defaults the first due date to today", () => {
    const r = parseQuickAdd("Water plants every 2 weeks", NOW);
    expect(r.title).toBe("Water plants");
    expect(r.recurrence).toEqual({ freq: "weekly", interval: 2 });
    expect(new Date(r.due_at!).getDate()).toBe(4);
  });

  it("treats 'every monday' as a weekly weekday rule", () => {
    expect(parseQuickAdd("Standup every monday", NOW).recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [1] });
  });

  it("keeps unknown !words and plain text untouched", () => {
    const r = parseQuickAdd("Buy milk !whoops", NOW);
    expect(r.title).toBe("Buy milk !whoops");
    expect(r.priority).toBe(0);
    expect(r.due_at).toBeNull();
  });
});
