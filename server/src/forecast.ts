/**
 * Sales pipeline arithmetic: what is open, what it is worth once each stage's chance of winning is applied, what has
 * been won and lost, and when the open deals are expected to close. Pure functions.
 */

export interface Stage {
  id: number | null;
  name: string;
  color: string;
  category: "todo" | "doing" | "done";
  /** Chance of winning a deal that sits in this stage, 0-100; null when it hasn't been set. */
  probability: number | null;
}

export interface Deal {
  status: string;
  status_id: number | null;
  value: number | null;
  /** The expected (or actual) close date. */
  due_at: string | null;
  completed_at?: string | null;
}

export interface StageTotals extends Stage {
  count: number;
  value: number;
  weighted: number;
}

export interface Forecast {
  open_count: number;
  open_value: number;
  /** Open value with each deal's stage probability applied. */
  weighted_value: number;
  won_count: number;
  won_value: number;
  lost_count: number;
  lost_value: number;
  /** Won as a share of won + lost, 0-100; null until a deal has closed. */
  win_rate: number | null;
  avg_won_value: number | null;
  by_stage: StageTotals[];
  /** Open deals by the month they are expected to close ("YYYY-MM"), soonest first. */
  by_month: { month: string; count: number; value: number; weighted: number }[];
  no_close_date: { count: number; value: number };
}

const money = (n: number) => Math.round(n * 100) / 100;

/** A finished deal is lost when its stage says 0%, and won otherwise. */
const isLost = (s: Stage) => s.category === "done" && s.probability === 0;

export function forecast(deals: Deal[], stages: Stage[]): Forecast {
  const firstOf = (category: Stage["category"]) => stages.find((s) => s.category === category);
  const stageOf = (d: Deal): Stage =>
    stages.find((s) => s.id !== null && s.id === d.status_id) ?? firstOf(d.status as Stage["category"]) ?? stages[0];

  const totals: StageTotals[] = stages.map((s) => ({ ...s, count: 0, value: 0, weighted: 0 }));
  const byMonth = new Map<string, { count: number; value: number; weighted: number }>();
  const out: Forecast = {
    open_count: 0, open_value: 0, weighted_value: 0, won_count: 0, won_value: 0, lost_count: 0, lost_value: 0,
    win_rate: null, avg_won_value: null, by_stage: totals, by_month: [], no_close_date: { count: 0, value: 0 },
  };

  for (const d of deals) {
    const stage = stageOf(d);
    const row = totals.find((t) => t.id === stage.id && t.name === stage.name)!;
    const value = d.value ?? 0;
    const weighted = stage.category === "done" ? 0 : (value * (stage.probability ?? 0)) / 100;
    row.count += 1;
    row.value += value;
    row.weighted += weighted;
    if (stage.category === "done") {
      if (isLost(stage)) {
        out.lost_count += 1;
        out.lost_value += value;
      } else {
        out.won_count += 1;
        out.won_value += value;
      }
      continue;
    }
    out.open_count += 1;
    out.open_value += value;
    out.weighted_value += weighted;
    if (d.due_at) {
      const month = d.due_at.slice(0, 7);
      const m = byMonth.get(month) ?? { count: 0, value: 0, weighted: 0 };
      m.count += 1;
      m.value += value;
      m.weighted += weighted;
      byMonth.set(month, m);
    } else {
      out.no_close_date.count += 1;
      out.no_close_date.value += value;
    }
  }

  const closed = out.won_count + out.lost_count;
  out.win_rate = closed === 0 ? null : Math.round((out.won_count / closed) * 100);
  out.avg_won_value = out.won_count === 0 ? null : money(out.won_value / out.won_count);
  for (const k of ["open_value", "weighted_value", "won_value", "lost_value"] as const) out[k] = money(out[k]);
  out.no_close_date.value = money(out.no_close_date.value);
  for (const t of totals) {
    t.value = money(t.value);
    t.weighted = money(t.weighted);
  }
  out.by_month = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({ month, count: m.count, value: money(m.value), weighted: money(m.weighted) }));
  return out;
}
