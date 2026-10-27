import { describe, expect, it } from "vitest";
import { forecast, type Deal, type Stage } from "./forecast.js";
import { minutesBetween, parseStamp, sla } from "./sla.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const ticket = (over: Partial<Parameters<typeof sla>[0]> = {}) => ({ created_at: "2026-03-10 08:00:00", first_response_at: null, completed_at: null, status: "todo", ...over });

describe("parsing timestamps", () => {
  it("reads the database's UTC format and ISO alike", () => {
    expect(parseStamp("2026-03-10 08:00:00")).toBe(Date.parse("2026-03-10T08:00:00Z"));
    expect(parseStamp("2026-03-10T08:00:00.000Z")).toBe(Date.parse("2026-03-10T08:00:00Z"));
    expect(minutesBetween("2026-03-10 08:00:00", "2026-03-10T09:30:00.000Z")).toBe(90);
    expect(minutesBetween("2026-03-10 09:00:00", "2026-03-10 08:00:00")).toBe(0);
  });
});

describe("service targets", () => {
  it("has no clocks without targets", () => {
    expect(sla(ticket(), { first_response_hours: null, resolution_hours: null }, NOW)).toBeNull();
  });

  it("waits, warns when little time is left, then breaches", () => {
    const targets = { first_response_hours: 8, resolution_hours: null };
    const at = (iso: string) => sla(ticket(), targets, new Date(iso))!.response!;
    expect(at("2026-03-10T09:00:00.000Z")).toEqual({ due: "2026-03-10T16:00:00.000Z", state: "pending" });
    expect(at("2026-03-10T15:00:00.000Z").state).toBe("at_risk"); // under a quarter of the 8 hours left
    expect(at("2026-03-10T16:00:01.000Z").state).toBe("breached");
    expect(sla(ticket(), targets, NOW)!.resolution).toBeNull();
  });

  it("is met by a response in time and late for one after the deadline", () => {
    const targets = { first_response_hours: 4, resolution_hours: null };
    expect(sla(ticket({ first_response_at: "2026-03-10T11:00:00.000Z" }), targets, NOW)!.response!.state).toBe("met");
    expect(sla(ticket({ first_response_at: "2026-03-10T13:00:00.000Z" }), targets, new Date("2026-03-11T00:00:00.000Z"))!.response!.state).toBe("late");
  });

  it("measures resolution to the time the ticket was completed", () => {
    const targets = { first_response_hours: null, resolution_hours: 24 };
    expect(sla(ticket({ status: "done", completed_at: "2026-03-10T20:00:00.000Z" }), targets, new Date("2026-03-20T00:00:00.000Z"))!.resolution!.state).toBe("met");
    expect(sla(ticket({ status: "done", completed_at: "2026-03-12T20:00:00.000Z" }), targets, new Date("2026-03-20T00:00:00.000Z"))!.resolution!.state).toBe("late");
    expect(sla(ticket({ status: "doing" }), targets, new Date("2026-03-12T00:00:00.000Z"))!.resolution!.state).toBe("breached");
    // a reopened ticket has no completion time to count
    expect(sla(ticket({ status: "todo", completed_at: "2026-03-10T09:00:00.000Z" }), targets, NOW)!.resolution!.state).toBe("pending");
  });
});

const stages: Stage[] = [
  { id: 1, name: "New", color: "#000", category: "todo", probability: 10 },
  { id: 2, name: "Qualified", color: "#000", category: "doing", probability: 60 },
  { id: 3, name: "Won", color: "#000", category: "done", probability: 100 },
  { id: 4, name: "Lost", color: "#000", category: "done", probability: 0 },
];
const deal = (over: Partial<Deal>): Deal => ({ status: "todo", status_id: 1, value: 1000, due_at: null, ...over });

describe("pipeline forecast", () => {
  it("is all zeros with no deals", () => {
    const f = forecast([], stages);
    expect(f).toMatchObject({ open_count: 0, open_value: 0, weighted_value: 0, win_rate: null, avg_won_value: null, by_month: [] });
    expect(f.by_stage.map((s) => s.count)).toEqual([0, 0, 0, 0]);
  });

  it("weights open deals by their stage's chance of winning", () => {
    const f = forecast([deal({ value: 1000 }), deal({ status: "doing", status_id: 2, value: 2000 }), deal({ status: "doing", status_id: 2, value: 500 })], stages);
    expect(f).toMatchObject({ open_count: 3, open_value: 3500, weighted_value: 100 + 1200 + 300 });
    expect(f.by_stage.find((s) => s.name === "Qualified")).toMatchObject({ count: 2, value: 2500, weighted: 1500 });
  });

  it("counts a finished deal as won, or as lost when its stage has no chance", () => {
    const f = forecast([
      deal({ status: "done", status_id: 3, value: 4000 }), deal({ status: "done", status_id: 3, value: 2000 }),
      deal({ status: "done", status_id: 4, value: 1000 }), deal({ value: 300 }),
    ], stages);
    expect(f).toMatchObject({ won_count: 2, won_value: 6000, lost_count: 1, lost_value: 1000, win_rate: 67, avg_won_value: 3000, open_count: 1, open_value: 300 });
  });

  it("treats a deal with no value as zero, and one with no explicit stage as its category's first", () => {
    const f = forecast([deal({ value: null }), deal({ status: "doing", status_id: null, value: 100 })], stages);
    expect(f).toMatchObject({ open_count: 2, open_value: 100, weighted_value: 60 });
  });

  it("groups open deals by expected close month, leaving out closed ones", () => {
    const f = forecast([
      deal({ value: 1000, due_at: "2026-05-20T00:00:00.000Z" }), deal({ status: "doing", status_id: 2, value: 1000, due_at: "2026-04-02T00:00:00.000Z" }),
      deal({ value: 500, due_at: "2026-04-28T00:00:00.000Z" }), deal({ value: 700 }), deal({ status: "done", status_id: 3, value: 9000, due_at: "2026-04-01T00:00:00.000Z" }),
    ], stages);
    expect(f.by_month).toEqual([{ month: "2026-04", count: 2, value: 1500, weighted: 650 }, { month: "2026-05", count: 1, value: 1000, weighted: 100 }]);
    expect(f.no_close_date).toEqual({ count: 1, value: 700 });
  });

  it("works with the built-in stages, which have no probability", () => {
    const builtin: Stage[] = [
      { id: null, name: "To do", color: "#000", category: "todo", probability: null },
      { id: null, name: "Doing", color: "#000", category: "doing", probability: null },
      { id: null, name: "Done", color: "#000", category: "done", probability: null },
    ];
    const f = forecast([deal({ status: "todo", status_id: null }), deal({ status: "done", status_id: null, value: 50 })], builtin);
    expect(f).toMatchObject({ open_value: 1000, weighted_value: 0, won_count: 1, won_value: 50 });
  });
});
