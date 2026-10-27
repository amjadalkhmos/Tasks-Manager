import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LifeBuoy } from "lucide-react";
import { api, type Project, type SlaState, type Task } from "../api";
import { clockText, urgentClock } from "../lib/sla";
import { PRIORITY } from "../lib/tasks";
import { timeAgo } from "../lib/time";
import { useStatuses } from "../lib/statuses";
import { EmptyState } from "./EmptyState";
import { SlaBadge } from "./SlaBadge";
import { StatusChip } from "./StatusChip";

const RANK: Record<SlaState, number> = { breached: 0, at_risk: 1, pending: 2, late: 3, met: 4 };

/** The support queue: open tickets with the most urgent first, and the state of each ticket's clocks. */
export function TicketQueue({ project, onOpen }: { project: Project; onOpen: (id: number) => void }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const statuses = useStatuses();
  const [showResolved, setShowResolved] = useState(false);
  const tickets = (tasks.data ?? []).filter((t) => t.project_id === project.id && t.ticket_no !== null);
  const open = tickets.filter((t) => t.status !== "done");
  const shown = showResolved ? tickets : open;
  const urgency = (t: Task) => {
    const c = urgentClock(t);
    return c ? RANK[c.state] : 5;
  };
  const rows = [...shown].sort(
    (a, b) => Number(a.status === "done") - Number(b.status === "done") || urgency(a) - urgency(b) || b.priority - a.priority || (a.ticket_no ?? 0) - (b.ticket_no ?? 0),
  );

  return (
    <div>
      <div className="timeline-tools">
        <span className="muted small">{open.length} open · most urgent first</span>
        <label className="toggle">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<LifeBuoy size={28} />} title="No tickets">
          Tickets arrive from the support form or by email, or you can add one from the list view.
        </EmptyState>
      ) : (
        <div className="panel portfolio-wrap" style={{ padding: 0 }}>
          <table className="portfolio-table queue">
            <thead>
              <tr><th>#</th><th>Subject</th><th>From</th><th>Priority</th><th>Status</th><th>Waiting</th><th>Reply</th><th>Resolution</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={t.status === "done" ? "resolved" : ""} onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(t.id)}>
                  <td className="ticket-no">#{t.ticket_no}</td>
                  <td><button type="button" className="g-title" onClick={(e) => (e.stopPropagation(), onOpen(t.id))}>{t.title}</button></td>
                  <td>{t.requester_name ?? <span className="muted">—</span>}</td>
                  <td>{t.priority > 0 ? <span className={`pill p${t.priority}`}>{PRIORITY[t.priority]}</span> : <span className="muted">—</span>}</td>
                  <td><StatusChip status={statuses.of(t)} /></td>
                  <td className="muted small">{timeAgo(t.created_at.replace(" ", "T") + (t.created_at.includes("T") ? "" : "Z")).replace(" ago", "")}</td>
                  <td>{t.sla?.response ? <SlaBadge clock={clockText("Reply", t.sla.response)} /> : <span className="muted">—</span>}</td>
                  <td>{t.sla?.resolution ? <SlaBadge clock={clockText("Resolution", t.sla.resolution)} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
