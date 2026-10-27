import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { api, type AttentionList } from "../api";
import { EmptyState } from "../components/EmptyState";
import { HealthBadge, ProgressBar } from "../components/ProjectBadges";
import { describeDeadline, formatDay } from "../lib/projects";

function TaskGroup({ title, list, onOpen, hint }: { title: string; list: AttentionList; onOpen: (id: number) => void; hint?: string }) {
  if (list.total === 0) return null;
  return (
    <section className="panel" aria-label={title}>
      <h2>{title} <span className="muted small">{list.total}</span></h2>
      {hint && <p className="muted small">{hint}</p>}
      <ul className="attention-rows">
        {list.items.map((t) => (
          <li key={t.id}>
            <button type="button" className="link" onClick={() => onOpen(t.id)}>{t.title}</button>
            <span className="muted small">
              {t.project_name ?? "Inbox"}
              {t.due_at && ` · due ${new Date(t.due_at).toLocaleDateString()}`}
            </span>
          </li>
        ))}
      </ul>
      {list.total > list.items.length && <p className="muted small">Showing {list.items.length} of {list.total}.</p>}
    </section>
  );
}

/**
 * Where to look first. Everyone sees projects that are slipping and their own overdue or blocked work. Managers of a
 * workspace also see everything in it that is unassigned, and how the work is spread across people.
 */
export function AttentionPage({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useQuery({ queryKey: ["attention"], queryFn: api.attention });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const a = q.data;
  const nothing = a && a.projects.length === 0 && a.overdue.total === 0 && a.blocked.total === 0 && a.unassigned.total === 0;
  const wsName = (id: number) => workspaces.data?.find((w) => w.id === id)?.name ?? "Workspace";
  const loads = (id: number) => (a?.workload ?? []).filter((w) => w.workspace_id === id);
  const managed = [...new Set((a?.workload ?? []).map((w) => w.workspace_id))];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Needs attention</h1>
          <p className="sub">{a?.is_manager ? "Projects drifting off plan and work that needs someone, across everything you manage." : "Projects drifting off plan, and your own overdue or blocked work."}</p>
        </div>
      </header>
      {q.error && <p className="alert" role="alert">{q.error.message}</p>}
      {nothing && <EmptyState icon={<CircleCheck size={28} />} title="All clear">No project is slipping, and nothing is overdue, blocked or waiting for an owner.</EmptyState>}

      {a && a.projects.length > 0 && (
        <section className="panel" aria-label="Projects to look at">
          <h2>Projects to look at <span className="muted small">{a.projects.length}</span></h2>
          <ul className="attention-projects">
            {a.projects.map((p) => {
              const d = describeDeadline(p.target_date);
              return (
                <li key={p.id}>
                  <div className="head">
                    <Link className="name" to={`/project/${p.id}?tab=overview`}><span className="dot" style={{ background: p.color }} />{p.name}</Link>
                    <HealthBadge health={p.health ?? p.suggested_health} />
                    {d && <span className={`small ${d.late ? "late-text" : "muted"}`}>{formatDay(p.target_date)} · {d.text}</span>}
                  </div>
                  <ProgressBar done={p.progress_pct} total={100} label={`${p.name} progress`} />
                  <ul className="signals">
                    {p.signals.map((s) => <li key={s.code}>{s.text}</li>)}
                    {p.signals.length === 0 && <li>Rated {p.health === "off_track" ? "off track" : "at risk"} by the team</li>}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {a && <TaskGroup title="Overdue" list={a.overdue} onOpen={onOpen} hint={a.is_manager ? "Yours, and everyone's in the workspaces you manage." : undefined} />}
      {a && <TaskGroup title="Blocked" list={a.blocked} onOpen={onOpen} hint="Waiting on unfinished work." />}
      {a && <TaskGroup title="Nobody is assigned" list={a.unassigned} onOpen={onOpen} hint="Open tasks in the workspaces you manage that have no owner." />}

      {a && managed.map((id) => (
        <section className="panel" key={id} aria-label={`Workload in ${wsName(id)}`}>
          <h2>Workload · {wsName(id)}</h2>
          <table className="portfolio-table">
            <thead><tr><th>Person</th><th>Open</th><th>Overdue</th></tr></thead>
            <tbody>
              {loads(id).map((w) => (
                <tr key={w.assignee_id ?? "none"}>
                  <td>{w.name ?? <span className="muted">Unassigned</span>}</td>
                  <td>{w.open}</td>
                  <td className={w.overdue ? "late-text" : "muted"}>{w.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
