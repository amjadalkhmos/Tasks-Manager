import type { Health, Stage } from "../api";
import { HEALTH_LABEL, STAGE_LABEL } from "../lib/projects";

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`pbadge stage-${stage}`}>{STAGE_LABEL[stage]}</span>;
}

export function HealthBadge({ health }: { health: Health | null }) {
  if (!health) return <span className="pbadge health-none">No updates</span>;
  return <span className={`pbadge health-${health}`}>{HEALTH_LABEL[health]}</span>;
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label ?? "Progress"}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
