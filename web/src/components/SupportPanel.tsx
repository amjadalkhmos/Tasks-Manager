import type { SupportStats } from "../api";
import { formatDuration } from "../lib/money";

/** How the support desk is doing: what is waiting, what is overdue, and how fast it answers. */
export function SupportPanel({ s }: { s: SupportStats }) {
  const breaching = s.response_breached + s.resolution_breached;
  const hasTargets = !!(s.targets.first_response_hours || s.targets.resolution_hours);
  return (
    <section className="panel" aria-label="Support desk" style={{ marginBottom: 16 }}>
      <h2>Support desk</h2>
      <div className="pm-stats" style={{ marginBottom: 12 }}>
        <div className="stat"><span>Open tickets</span><strong>{s.open}</strong></div>
        <div className="stat"><span>Not answered yet</span><strong>{s.unanswered}</strong></div>
        <div className="stat">
          <span>Past their target</span>
          <strong className={breaching ? "overdue" : ""}>{hasTargets ? breaching : "—"}</strong>
        </div>
        <div className="stat"><span>Due soon</span><strong>{hasTargets ? s.at_risk : "—"}</strong></div>
      </div>
      <div className="pm-stats" style={{ marginBottom: 8 }}>
        <div className="stat"><span>Average first reply</span><strong>{formatDuration(s.avg_first_response_min)}</strong></div>
        <div className="stat"><span>Average resolution</span><strong>{formatDuration(s.avg_resolution_min)}</strong></div>
        <div className="stat"><span>New this week</span><strong>{s.created_7d}</strong></div>
        <div className="stat"><span>Resolved this week</span><strong>{s.resolved_7d}</strong></div>
      </div>
      {!hasTargets && <p className="muted small">No service targets are set. Add a first-reply and a resolution time in Settings to see which tickets are running late.</p>}
    </section>
  );
}
