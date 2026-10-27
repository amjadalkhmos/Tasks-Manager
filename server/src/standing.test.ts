import { describe, expect, it } from "vitest";
import { standing, type MilestoneLite, type TaskLite } from "./standing.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const task = (over: Partial<TaskLite> = {}): TaskLite => ({ status: "todo", due_at: null, estimate_min: null, milestone_id: null, ...over });
const ms = (over: Partial<MilestoneLite> & { id: number }): MilestoneLite => ({ name: `M${over.id}`, due_date: null, completed_at: null, ...over });
const active = { stage: "active", start_date: null, target_date: null };

describe("progress", () => {
  it("is zero for a project with no tasks", () => {
    expect(standing(active, [], [], NOW)).toMatchObject({ tasks_total: 0, progress_pct: 0, signals: [], suggested_health: "on_track" });
  });

  it("weighs tasks by their estimate, and counts an unestimated task as an hour", () => {
    const tasks = [task({ status: "done", estimate_min: 180 }), task({ estimate_min: 60 }), task()]; // 180 done of 180 + 60 + 60
    expect(standing(active, tasks, [], NOW).progress_pct).toBe(60);
    expect(standing(active, [task({ status: "done" }), task(), task(), task()], [], NOW).progress_pct).toBe(25);
  });

  it("counts done and doing tasks", () => {
    const s = standing(active, [task({ status: "done" }), task({ status: "doing" }), task({ status: "doing" }), task()], [], NOW);
    expect(s).toMatchObject({ tasks_total: 4, tasks_done: 1, tasks_doing: 2 });
  });
});

describe("signals", () => {
  it("flags overdue open tasks, but not done ones or future ones", () => {
    const s = standing(active, [task({ due_at: "2026-03-01T00:00:00.000Z" }), task({ status: "done", due_at: "2026-03-01T00:00:00.000Z" }), task({ due_at: "2026-04-01T00:00:00.000Z" })], [], NOW);
    expect(s.tasks_overdue).toBe(1);
    expect(s.signals.map((x) => x.code)).toEqual(["overdue_tasks"]);
    expect(s.signals[0].text).toBe("1 task overdue");
    expect(s.suggested_health).toBe("at_risk");
  });

  it("is off track once the target date has passed with work still open", () => {
    const s = standing({ stage: "active", start_date: "2026-01-01", target_date: "2026-03-01" }, [task(), task({ status: "done" })], [], NOW);
    expect(s.signals.map((x) => x.code)).toContain("target_passed");
    expect(s.suggested_health).toBe("off_track");
    // finished work is fine however late
    expect(standing({ stage: "active", start_date: null, target_date: "2026-03-01" }, [task({ status: "done" })], [], NOW).suggested_health).toBe("on_track");
  });

  it("notices when the work is behind the clock", () => {
    const plan = { stage: "active", start_date: "2026-03-01", target_date: "2026-03-29" }; // half the time used on the 15th
    const behind = standing(plan, [task(), task(), task(), task({ status: "done" })], [], NOW); // 25% done
    expect(behind.signals.map((x) => x.code)).toEqual(["behind_schedule"]);
    expect(behind.suggested_health).toBe("at_risk");
    const wayBehind = standing(plan, [task(), task(), task(), task(), task(), task(), task(), task(), task(), task({ status: "done" })], [], NOW); // 10% done
    expect(wayBehind.suggested_health).toBe("off_track");
    const fine = standing(plan, [task({ status: "done" }), task({ status: "done" }), task()], [], NOW);
    expect(fine.signals).toEqual([]);
  });

  it("ignores the schedule in the first days and without both dates", () => {
    expect(standing({ stage: "active", start_date: "2026-03-14", target_date: "2026-06-14" }, [task()], [], NOW).signals).toEqual([]);
    expect(standing({ stage: "active", start_date: null, target_date: "2026-03-29" }, [task()], [], NOW).signals).toEqual([]);
  });

  it("only judges active projects", () => {
    const late = [task({ due_at: "2026-03-01T00:00:00.000Z" })];
    for (const stage of ["planning", "on_hold", "completed", "archived"]) {
      expect(standing({ stage, start_date: null, target_date: "2026-03-01" }, late, [], NOW)).toMatchObject({ signals: [], suggested_health: null });
    }
  });
});

describe("milestones", () => {
  it("counts each milestone's tasks and picks the next open one with a date", () => {
    const s = standing(active, [task({ milestone_id: 1, status: "done" }), task({ milestone_id: 1 }), task({ milestone_id: 2 }), task()], [
      ms({ id: 1, due_date: "2026-04-10" }), ms({ id: 2, due_date: "2026-03-30" }), ms({ id: 3, completed_at: "2026-03-01T00:00:00.000Z", due_date: "2026-03-02" }), ms({ id: 4 }),
    ], NOW);
    expect(s.milestones.map((m) => [m.id, m.tasks_done, m.tasks_total])).toEqual([[1, 1, 2], [2, 0, 1], [3, 0, 0], [4, 0, 0]]);
    expect(s).toMatchObject({ milestones_total: 4, milestones_done: 1, next_milestone: { name: "M2", due_date: "2026-03-30" } });
  });

  it("flags an overdue milestone, but not a completed one", () => {
    const s = standing(active, [], [ms({ id: 1, due_date: "2026-03-01" }), ms({ id: 2, due_date: "2026-03-01", completed_at: "2026-02-28T00:00:00.000Z" })], NOW);
    expect(s.milestones.map((m) => m.overdue)).toEqual([true, false]);
    expect(s.signals).toEqual([{ code: "milestone_overdue", text: "Milestone “M1” is overdue" }]);
  });

  it("warns when tasks are scheduled after their milestone's date", () => {
    const s = standing(active, [task({ milestone_id: 1, due_at: "2026-04-20T00:00:00.000Z" })], [ms({ id: 1, due_date: "2026-04-10" })], NOW);
    expect(s.milestones[0].tasks_late).toBe(1);
    expect(s.signals.map((x) => x.code)).toEqual(["milestone_slipping"]);
    expect(s.suggested_health).toBe("at_risk");
  });
});
