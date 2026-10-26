import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../api";
import { describeActivity } from "./activity";
import { timeAgo } from "./time";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("timeAgo", () => {
  it("speaks in the largest sensible unit", () => {
    expect(timeAgo(ago(10_000), NOW)).toBe("just now");
    expect(timeAgo(ago(60_000), NOW)).toBe("1 minute ago");
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe("3 hours ago");
    expect(timeAgo(ago(2 * 86_400_000), NOW)).toBe("2 days ago");
    expect(timeAgo(ago(14 * 86_400_000), NOW)).toBe("2 weeks ago");
  });

  it("falls back to a date for old things and never shows a negative age", () => {
    expect(timeAgo(ago(90 * 86_400_000), NOW)).toMatch(/2025|Dec/);
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now"); // clock skew
  });
});

describe("describeActivity", () => {
  const nameOf = (id: number | null | undefined) => ({ 2: "Bob" })[id as 2] ?? "A former member";
  const item = (kind: string, detail: Record<string, unknown>): ActivityItem => ({ id: 1, kind, user_id: 1, task_id: 5, detail, created_at: "" });

  it("describes the things people do", () => {
    expect(describeActivity(item("task_created", { title: "Ship" }), nameOf)).toBe("created “Ship”");
    expect(describeActivity(item("task_assigned", { title: "Ship", assignee_id: 2 }), nameOf)).toBe("assigned “Ship” to Bob");
    expect(describeActivity(item("project_deleted", { name: "Old", tasks: 1 }), nameOf)).toBe("deleted the project “Old” and its 1 task");
    expect(describeActivity(item("project_deleted", { name: "Old", tasks: 3 }), nameOf)).toBe("deleted the project “Old” and its 3 tasks");
    expect(describeActivity(item("role_changed", { user_id: 2, from: "viewer", to: "member" }), nameOf)).toBe("changed Bob from viewer to member");
    expect(describeActivity(item("workspace_renamed", { from: "A", to: "B" }), nameOf)).toBe("renamed the workspace from “A” to “B”");
  });

  it("copes with people who have since left, and with kinds it doesn't know", () => {
    expect(describeActivity(item("member_removed", { user_id: 99 }), nameOf)).toBe("removed A former member");
    expect(describeActivity(item("something_new", {}), nameOf)).toBe("something new");
  });
});
