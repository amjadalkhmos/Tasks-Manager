import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ReceiptText, PackageCheck } from "lucide-react";
import { api, type MilestoneProgress, type MilestoneState } from "../api";
import { formatDay } from "../lib/projects";
import { formatMoney } from "../lib/money";
import { MilestoneDialog } from "./MilestoneDialog";
import { ProgressBar } from "./ProjectBadges";

export const STATE_LABEL: Record<MilestoneState, string> = { upcoming: "Upcoming", at_risk: "At risk", achieved: "Achieved", missed: "Missed" };
const STATE_CLASS: Record<MilestoneState, string> = { upcoming: "", at_risk: "health-at_risk", achieved: "health-on_track", missed: "health-off_track" };

export function MilestoneBadge({ state, risks }: { state: MilestoneState; risks?: string[] }) {
  return <span className={`pbadge ${STATE_CLASS[state]}`} title={risks?.length ? risks.join("\n") : undefined}>{STATE_LABEL[state]}</span>;
}

/** "Payment $5,000", "Deliverable", and what is left to do about it. */
export function MarkerChips({ m, currency }: { m: Pick<MilestoneProgress, "marker" | "amount" | "outcome" | "invoiced_at">; currency: string }) {
  if (!m.marker) return null;
  const ready = m.marker === "payment" && m.outcome === "achieved" && !m.invoiced_at;
  return (
    <>
      <span className="marker-chip">
        {m.marker === "payment" ? <ReceiptText size={12} /> : <PackageCheck size={12} />}
        {m.marker === "payment" ? `Payment${m.amount !== null ? ` ${formatMoney(m.amount, currency)}` : ""}` : "Deliverable"}
      </span>
      {ready && <span className="pbadge health-at_risk">Ready to invoice</span>}
      {m.marker === "payment" && m.invoiced_at && <span className="pbadge health-on_track">Invoiced</span>}
    </>
  );
}

/** The dates of a milestone: the forecast, and what it was first promised if that has moved. */
export function MilestoneDates({ m }: { m: Pick<MilestoneProgress, "due_date" | "baseline_date" | "slipped_days" | "state" | "outcome"> }) {
  if (!m.due_date) return <span className="muted small">No date</span>;
  const late = m.outcome === null && m.due_date < new Date().toISOString().slice(0, 10);
  return (
    <span className="ms-dates">
      <span className={late ? "late" : ""}>{formatDay(m.due_date)}</span>
      {m.baseline_date && m.baseline_date !== m.due_date && (
        <span className="muted small" title="The date it was first promised">
          {" "}baseline {formatDay(m.baseline_date)}{m.slipped_days > 0 ? ` · +${m.slipped_days}d` : m.due_date < m.baseline_date ? " · ahead" : ""}
        </span>
      )}
    </span>
  );
}

/** The project's checkpoints: each with its state, owner, dates, and what is left to do about it. Click one for the detail. */
export function MilestonePanel({ projectId, workspaceId, milestones, canWrite, canSignOff, currency, refresh, onOpenTask }: {
  projectId: number;
  workspaceId: number | null;
  milestones: MilestoneProgress[];
  canWrite: boolean;
  canSignOff: boolean;
  currency: string;
  refresh: () => Promise<unknown>;
  onOpenTask: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [due, setDue] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const add = useMutation({
    mutationFn: () => api.addMilestone(projectId, { name: name.trim(), due_date: due || null }),
    onSuccess: async (m) => {
      setName("");
      setDue("");
      await refresh();
      setOpen(m.id);
    },
  });
  const achieved = milestones.filter((m) => m.state === "achieved").length;
  const atRisk = milestones.filter((m) => m.state === "at_risk").length;
  const missed = milestones.filter((m) => m.state === "missed").length;

  return (
    <section className="panel span-2" aria-label="Milestones">
      <h2>
        Milestones{" "}
        {milestones.length > 0 && (
          <span className="muted small">
            {achieved}/{milestones.length} achieved{atRisk ? ` · ${atRisk} at risk` : ""}{missed ? ` · ${missed} missed` : ""}
          </span>
        )}
      </h2>
      {milestones.length === 0 && <p className="muted small">No milestones yet. A milestone is a dated checkpoint, like “Beta released”, that the project's lead signs off when it is really met.</p>}
      <ul className="ms-list">
        {milestones.map((m) => (
          <li key={m.id} className={`ms-row ms-${m.state}`}>
            <button type="button" className="ms-open" onClick={() => setOpen(m.id)} aria-label={`Open ${m.name}`}>
              <span className="ms-title">
                <strong>{m.name}</strong>
                <MilestoneBadge state={m.state} risks={m.risks} />
                <MarkerChips m={m} currency={currency} />
              </span>
              <span className="ms-meta">
                <MilestoneDates m={m} />
                {m.owner_name && <span className="muted small">{m.owner_name}</span>}
                {m.slips > 0 && <span className="muted small">moved {m.slips}×</span>}
              </span>
              {m.state === "at_risk" && m.risks[0] && <span className="ms-risk">{m.risks[0]}{m.risks.length > 1 ? ` (+${m.risks.length - 1} more)` : ""}</span>}
              {m.tasks_total > 0 && (
                <span className="ms-progress">
                  <ProgressBar done={m.tasks_done} total={m.tasks_total} label={`${m.name} progress`} />
                  <span className="muted small">{m.tasks_done}/{m.tasks_total} tasks</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="add-line" onSubmit={(e) => (e.preventDefault(), name.trim() && add.mutate())}>
          <input aria-label="New milestone" placeholder="Add a milestone…" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          <input type="date" aria-label="Milestone date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button type="submit" className="secondary" disabled={!name.trim() || add.isPending}>Add</button>
        </form>
      )}
      {add.error && <p className="alert" role="alert">{add.error.message}</p>}
      {open !== null && (
        <MilestoneDialog
          id={open}
          standing={milestones.find((m) => m.id === open)}
          workspaceId={workspaceId}
          currency={currency}
          canSignOff={canSignOff}
          onClose={() => setOpen(null)}
          onChanged={refresh}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  );
}

