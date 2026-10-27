import { MilestoneBadge } from "../components/MilestonePanel";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import { api, type PortfolioRow, type Stage } from "../api";
import { EmptyState } from "../components/EmptyState";
import { HealthBadge, ProgressBar, StageBadge } from "../components/ProjectBadges";
import { HEALTH_LABEL, STAGE_LABEL, STAGE_ORDER, describeDeadline, formatDay } from "../lib/projects";
import { TYPE_INFO } from "../lib/projectTypes";
import { usePeople } from "../lib/people";

type Filter = "live" | "all" | Stage;

/** Every project across private work and workspaces, with where each one stands. */
export function PortfolioPage() {
  const rows = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const { nameOf } = usePeople();
  const [filter, setFilter] = useState<Filter>("live");
  const [workspace, setWorkspace] = useState("");

  const all = rows.data ?? [];
  const inWorkspace = (r: PortfolioRow) => workspace === "" || (workspace === "private" ? r.workspace_id === null : r.workspace_id === Number(workspace));
  const scoped = all.filter(inWorkspace);
  const shown = scoped.filter((r) => (filter === "all" ? true : filter === "live" ? r.stage !== "archived" && r.stage !== "completed" : r.stage === filter));
  const live = scoped.filter((r) => r.stage === "active");
  const countHealth = (h: PortfolioRow["health"]) => live.filter((r) => r.health === h).length;
  const wsName = (id: number | null) => (id === null ? "Private" : (workspaces.data?.find((w) => w.id === id)?.name ?? "Workspace"));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="sub">Where every project stands: stage, health, progress and dates.</p>
        </div>
        <div className="page-actions">
          <select aria-label="Show projects from" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">All workspaces</option>
            <option value="private">Private</option>
            {workspaces.data?.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
      </header>
      {rows.error && <p className="alert" role="alert">{rows.error.message}</p>}

      <div className="pm-stats" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="stat"><span>Active</span><strong>{live.length}</strong></div>
        <div className="stat"><span>On track</span><strong>{countHealth("on_track")}</strong></div>
        <div className="stat"><span>At risk</span><strong>{countHealth("at_risk")}</strong></div>
        <div className="stat"><span>Off track</span><strong className={countHealth("off_track") ? "overdue" : ""}>{countHealth("off_track")}</strong></div>
      </div>

      <div className="chip-row" role="group" aria-label="Filter by stage">
        {([["live", "In progress"], ["all", "All"], ...STAGE_ORDER.map((s) => [s, STAGE_LABEL[s]])] as [Filter, string][]).map(([key, label]) => (
          <button key={key} type="button" className={`chip${filter === key ? " on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>

      {rows.data && shown.length === 0 && (
        <EmptyState icon={<FolderKanban size={28} />} title="No projects here">
          {all.length === 0 ? "Create a project from the sidebar to start tracking it." : "No project matches this filter."}
        </EmptyState>
      )}

      {shown.length > 0 && (
        <div className="panel portfolio-wrap" style={{ padding: 0 }}>
          <table className="portfolio-table">
            <thead>
              <tr>
                <th>Project</th><th>Stage</th><th>Health</th><th>Progress</th><th>Overdue</th><th>Lead</th><th>Target</th><th>Next milestone</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const d = r.stage === "completed" || r.stage === "archived" ? null : describeDeadline(r.target_date);
                return (
                  <tr key={r.id}>
                    <td>
                      <Link className="name" to={`/project/${r.id}?tab=overview`}><span className="dot" style={{ background: r.color }} />{r.name}</Link>
                      <span className="muted small">{TYPE_INFO[r.type].label} · {wsName(r.workspace_id)}</span>
                    </td>
                    <td><StageBadge stage={r.stage} /></td>
                    <td>
                      <HealthBadge health={r.health} />
                      {r.suggested_health && r.suggested_health !== (r.health ?? "on_track") && (
                        <div className="muted small" title={r.signals.map((s) => s.text).join(". ")}>Numbers say: {HEALTH_LABEL[r.suggested_health]}</div>
                      )}
                    </td>
                    <td>
                      <div className="prog">
                        <ProgressBar done={r.progress_pct} total={100} label={`${r.name} progress`} />
                        <span className="muted small">{r.progress_pct}% · {r.tasks_done}/{r.tasks_total} tasks</span>
                      </div>
                    </td>
                    <td className={r.tasks_overdue ? "late-text" : "muted"}>{r.tasks_overdue}</td>
                    <td>{r.lead_id ? nameOf(r.lead_id) : <span className="muted">—</span>}</td>
                    <td>
                      {formatDay(r.target_date)}
                      {d && <div className={`small ${d.late ? "late-text" : "muted"}`}>{d.text}</div>}
                    </td>
                    <td>
                      {r.next_milestone ? (
                        <>
                          {r.next_milestone.name}{r.next_milestone.state === "at_risk" && <> <MilestoneBadge state="at_risk" /></>}
                          <div className="muted small">{formatDay(r.next_milestone.due_date)}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
