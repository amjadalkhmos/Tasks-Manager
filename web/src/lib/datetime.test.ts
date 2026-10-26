import { describe, expect, it } from "vitest";
import { formatRange, fromLocalInput, nextHour, safeUrl, toLocalInput } from "./datetime";

describe("datetime helpers", () => {
  it("round-trips local input values", () => {
    const iso = new Date(2026, 2, 4, 15, 30).toISOString();
    expect(toLocalInput(iso)).toBe("2026-03-04T15:30");
    expect(fromLocalInput("2026-03-04T15:30")).toBe(iso);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
  });

  it("starts new meetings on the next whole hour", () => {
    const d = nextHour(new Date(2026, 2, 4, 15, 20, 45));
    expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([16, 0, 0]);
    expect(nextHour(new Date(2026, 2, 4, 23, 59)).getDate()).toBe(5);
  });

  it("formats a range on one day, or across days", () => {
    const one = formatRange(new Date(2026, 2, 4, 15, 0).toISOString(), new Date(2026, 2, 4, 15, 30).toISOString());
    expect(one).toMatch(/·/);
    expect(one).not.toMatch(/→/);
    expect(formatRange(new Date(2026, 2, 4, 23, 0).toISOString(), new Date(2026, 2, 5, 1, 0).toISOString())).toMatch(/→/);
  });

  it("only turns web links into links", () => {
    expect(safeUrl("https://meet.example.com/a?b=1")).toBe("https://meet.example.com/a?b=1");
    expect(safeUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example", "not a url", "", null, undefined]) expect(safeUrl(bad as string)).toBeNull();
  });
});
