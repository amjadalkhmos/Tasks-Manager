import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Check, PartyPopper } from "lucide-react";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { createdAtMs, formatDue, formatMinutes, startOfDay } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

const STALE_DAYS = 14;

export function DashboardPage({ onOpen }: { onOpen: (id: number) => void }) {
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const actions = useTaskActions();

  const open = (tasks.data ?? []).filter((t) => t.status !== "done" && t.parent_id === null);
  const now = Date.now();
  const overdue = open.filter((t) => t.due_at && new Date(t.due_at).getTime() < now);
  // Created long ago and never given a date — candidates for the weekly review.
  const stale = open.filter((t) => !t.due_at && now - createdAtMs(t) > STALE_DAYS * 86_400_000);

  const s = stats.data;
  const maxDay = Math.max(1, ...(s?.completed_by_day.map((d) => d.count) ?? [1]));
  const maxTime = Math.max(1, ...(s?.time_by_project.map((p) => p.minutes) ?? [1]));
  const colorOf = (id: number | null) => projects.data?.find((p) => p.id === id)?.color ?? "var(--border-strong)";
  const todayKey = s?.completed_by_day.at(-1)?.day;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">Where your time and tasks went recently.</p>
        </div>
      </header>
      {stats.error && <p className="alert" role="alert">{stats.error.message}</p>}
      {actions.error && <p className="alert" role="alert">{actions.error}</p>}

      <div className="stat-grid">
        <div className="stat"><span>Open</span><strong>{s?.open_total ?? "–"}</strong></div>
        <div className="stat"><span>Overdue</span><strong className={s?.overdue ? "overdue" : ""}>{s?.overdue ?? "–"}</strong></div>
        <div className="stat"><span>Done this week</span><strong>{s?.completed_week ?? "–"}</strong></div>
      </div>

      <section className="panel">
        <h2>Completed per day <span className="muted small">· last 14 days</span></h2>
        <div className="bars" role="img" aria-label="Tasks completed per day over the last 14 days">
          {s?.completed_by_day.map((d) => (
            <div key={d.day} className={`bar-col${d.day === todayKey ? " today" : ""}${d.count === 0 ? " empty" : ""}`} title={`${d.day}: ${d.count}`}>
              <span className="bar-value">{d.count || ""}</span>
              <div className="bar" style={{ height: `${Math.max(2, (d.count / maxDay) * 100)}%` }} />
              <span className="bar-label">{Number(d.day.slice(8))}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Time tracked by project <span className="muted small">· last 7 days</span></h2>
        {s && s.time_by_project.length === 0 && <p className="muted">No time tracked yet — open a task and start its timer.</p>}
        <ul className="hbars">
          {s?.time_by_project.map((p) => (
            <li key={p.project_id ?? "none"}>
              <span className="name"><span className="dot" style={{ background: colorOf(p.project_id) }} />{p.name}</span>
              <div className="hbar"><div style={{ width: `${(p.minutes / maxTime) * 100}%`, background: colorOf(p.project_id) }} /></div>
              <span className="val">{formatMinutes(p.minutes)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="section-head">
        <h2>Weekly review</h2>
        <span className="muted small">Clear what’s stuck so next week starts clean.</span>
      </div>
      <h3 className="group-label danger">Overdue <span className="count">{overdue.length}</span></h3>
      <ReviewList
        tasks={overdue}
        empty={<EmptyState compact icon={<PartyPopper size={20} />} title="Nothing overdue" />}
        onOpen={onOpen}
        onComplete={(id) => actions.complete.mutate(id)}
        onToday={(id) => actions.patch.mutate({ id, due_at: startOfDay(new Date()).toISOString() })}
      />
      <h3 className="group-label" style={{ marginTop: 20 }}>Stale · no date, older than {STALE_DAYS} days <span className="count">{stale.length}</span></h3>
      <ReviewList
        tasks={stale}
        empty={<EmptyState compact icon={<CalendarCheck size={20} />} title="No stale tasks" />}
        onOpen={onOpen}
        onComplete={(id) => actions.complete.mutate(id)}
        onToday={(id) => actions.patch.mutate({ id, due_at: startOfDay(new Date()).toISOString() })}
      />
    </div>
  );
}

function ReviewList({
  tasks,
  empty,
  onOpen,
  onComplete,
  onToday,
}: {
  tasks: { id: number; title: string; due_at: string | null; blocked: boolean }[];
  empty: React.ReactNode;
  onOpen: (id: number) => void;
  onComplete: (id: number) => void;
  onToday: (id: number) => void;
}) {
  if (tasks.length === 0) return <>{empty}</>;
  return (
    <ul className="tasks">
      {tasks.map((t) => (
        <li key={t.id}>
          <button className="title" onClick={() => onOpen(t.id)}>{t.title}</button>
          <span className="meta">
            {t.due_at && <span className="overdue">{formatDue(t.due_at)}</span>}
            <span className="review-actions">
              <button type="button" className="secondary" onClick={() => onToday(t.id)}>Move to today</button>
              <button type="button" className="secondary" disabled={t.blocked} onClick={() => onComplete(t.id)}>
                <Check size={14} /> Complete
              </button>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
