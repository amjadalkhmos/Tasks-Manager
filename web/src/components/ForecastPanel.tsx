import type { PipelineForecast } from "../api";
import { formatMoney } from "../lib/money";

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" });

/** What the pipeline is worth: open, weighted by each stage's chance of winning, and what has been won or lost. */
export function ForecastPanel({ f }: { f: PipelineForecast }) {
  const cur = (n: number) => formatMoney(n, f.currency);
  const maxStage = Math.max(1, ...f.by_stage.filter((s) => s.category !== "done").map((s) => s.value));
  const maxMonth = Math.max(1, ...f.by_month.map((m) => m.value));
  const open = f.by_stage.filter((s) => s.category !== "done");

  return (
    <section className="panel" aria-label="Pipeline forecast" style={{ marginBottom: 16 }}>
      <h2>Forecast</h2>
      <div className="pm-stats" style={{ marginBottom: 16 }}>
        <div className="stat"><span>Open pipeline</span><strong>{cur(f.open_value)}<small> · {f.open_count} deal{f.open_count === 1 ? "" : "s"}</small></strong></div>
        <div className="stat"><span title="Open deals, each weighed by its stage's chance of winning">Weighted forecast</span><strong>{cur(f.weighted_value)}</strong></div>
        <div className="stat"><span>Won</span><strong>{cur(f.won_value)}<small> · {f.won_count}</small></strong></div>
        <div className="stat">
          <span>Win rate</span>
          <strong>{f.win_rate === null ? "—" : `${f.win_rate}%`}<small>{f.lost_count ? ` · ${f.lost_count} lost` : ""}</small></strong>
        </div>
      </div>

      <div className="pm-grid">
        <div>
          <h3 className="mini-title">By stage</h3>
          <ul className="bar-list forecast-bars">
            {open.map((s) => (
              <li key={s.name} style={{ ["--c" as string]: s.color }}>
                <span>{s.name}{s.probability !== null && <span className="muted small"> {s.probability}%</span>}</span>
                <span className="hbar"><span style={{ width: `${(s.value / maxStage) * 100}%` }} /></span>
                <span className="n" title={`${s.count} deal${s.count === 1 ? "" : "s"} · weighted ${cur(s.weighted)}`}>{cur(s.value)}</span>
              </li>
            ))}
          </ul>
          {open.some((s) => s.probability === null) && <p className="muted small">Some stages have no win chance yet, so their deals count as 0% in the forecast. Set them in Settings.</p>}
        </div>
        <div>
          <h3 className="mini-title">Expected to close</h3>
          {f.by_month.length === 0 && <p className="muted small">No open deal has an expected close date. Set one in the deal's panel.</p>}
          <ul className="bar-list forecast-bars">
            {f.by_month.map((m) => (
              <li key={m.month}>
                <span>{monthLabel(m.month)}</span>
                <span className="hbar"><span style={{ width: `${(m.value / maxMonth) * 100}%` }} /></span>
                <span className="n" title={`${m.count} deal${m.count === 1 ? "" : "s"}`}>{cur(m.weighted)}</span>
              </li>
            ))}
          </ul>
          {f.by_month.length > 0 && <p className="muted small">Weighted value of the deals due each month.</p>}
          {f.no_close_date.count > 0 && <p className="muted small">{f.no_close_date.count} open deal{f.no_close_date.count === 1 ? "" : "s"} ({cur(f.no_close_date.value)}) without an expected close date.</p>}
        </div>
      </div>
    </section>
  );
}
