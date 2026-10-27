import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Trash2, X } from "lucide-react";
import { api, type Health, type Project, type ProjectOverview, type ProjectType, type Stage, type Task } from "../api";
import { Board } from "../components/Board";
import { ForecastPanel } from "../components/ForecastPanel";
import { IntakeSettings } from "../components/IntakeSettings";
import { MilestonePanel } from "../components/MilestonePanel";
import { SupportPanel } from "../components/SupportPanel";
import { TicketQueue } from "../components/TicketQueue";
import { HealthBadge, ProgressBar, StageBadge } from "../components/ProjectBadges";
import { StatusManager } from "../components/StatusManager";
import { Timeline } from "../components/Timeline";
import { HEALTH_LABEL, STAGE_LABEL, describeDeadline, formatDay, percent, transitionLabel } from "../lib/projects";
import { PROJECT_TYPES, TYPE_INFO } from "../lib/projectTypes";
import { usePeople } from "../lib/people";
import { formatMinutes } from "../lib/tasks";
import { timeAgo } from "../lib/time";
import { TaskList } from "./TaskList";

type Tab = "overview" | "work" | "settings";
type View = "list" | "board" | "timeline" | "queue";
const TABS: [Tab, string][] = [["overview", "Overview"], ["work", "Work"], ["settings", "Settings"]];
const VIEWS: [View, string][] = [["queue", "Queue"], ["list", "List"], ["board", "Board"], ["timeline", "Timeline"]];

export function ProjectPage({ onOpen }: { onOpen: (id: number) => void }) {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["overview", id], queryFn: () => api.overview(id), retry: false });
  const [moving, setMoving] = useState<Stage | null>(null);
  const [note, setNote] = useState("");

  const refresh = () => Promise.all(["overview", "portfolio", "projects"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const stage = useMutation({
    mutationFn: ({ to, force }: { to: Stage; force: boolean }) => api.setStage(id, to, note.trim() || undefined, force),
    onSuccess: () => (setMoving(null), setNote(""), refresh()),
  });
  useEffect(() => (setMoving(null), setNote(""), stage.reset()), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (overview.isLoading) return <p className="muted">Loading…</p>;
  if (!overview.data) {
    return (
      <div className="empty">
        <h2>Project not found</h2>
        <p>It may have been deleted, or you may not have access to it.</p>
      </div>
    );
  }
  const o = overview.data;
  const p = o.project;
  const openTasks = o.progress.tasks_total - o.progress.tasks_done;
  const deadline = p.stage === "completed" || p.stage === "archived" ? null : describeDeadline(p.target_date);

  // Managers land on the overview (how is it going?); everyone else on the work (what do I do next?).
  const fallback: Tab = o.access.can_manage ? "overview" : "work";
  const tab = (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? fallback) as Tab;
  // The queue is for support desks; everything else offers list, board and timeline.
  const views = VIEWS.filter(([v]) => v !== "queue" || p.type === "support");
  const view = (views.find(([v]) => v === params.get("view"))?.[0] ?? TYPE_INFO[p.type].view) as View;
  const go = (next: { tab?: Tab; view?: View }) => {
    const q = new URLSearchParams(params);
    if (next.tab) q.set("tab", next.tab);
    if (next.view) q.set("view", next.view);
    setParams(q, { replace: true });
  };

  return (
    <div>
      <header className="project-head">
        <div className="title-row">
          <h1><span className="dot" style={{ background: p.color }} />{p.name}</h1>
          <StageBadge stage={p.stage} />
          <HealthBadge health={o.progress.health} />
          {o.access.can_manage && o.transitions.length > 0 && !moving && (
            <div className="lifecycle">
              {o.transitions.map((to) => (
                <button key={to} type="button" className={to === "active" || to === "completed" ? "secondary" : "ghost"} onClick={() => setMoving(to)}>
                  {transitionLabel(p.stage, to)}
                </button>
              ))}
            </div>
          )}
        </div>
        {p.description && <p className="desc">{p.description}</p>}
        {p.type === "pipeline" && (
          <p className="alert warn">
            Sales now has its own area, with leads, accounts and deals that aren't tasks.{" "}
            {o.access.can_manage && p.workspace_id !== null ? <Link to={`/sales/${p.workspace_id}/settings`}>Move this pipeline into Sales</Link> : "Ask an admin to move this pipeline into Sales."}
          </p>
        )}
        <div className="facts">
          <span>{TYPE_INFO[p.type].label}</span>
          {p.lead_name && <span>Lead: {p.lead_name}</span>}
          {(p.start_date || p.target_date) && <span>{formatDay(p.start_date)} → {formatDay(p.target_date)}</span>}
          {deadline && <span className={deadline.late ? "late-text" : ""}>{deadline.text}</span>}
        </div>

        {moving && (
          <form
            className="stage-form"
            aria-label={`${transitionLabel(p.stage, moving)}`}
            onSubmit={(e) => {
              e.preventDefault();
              stage.mutate({ to: moving, force: moving === "completed" && openTasks > 0 });
            }}
          >
            <strong>{transitionLabel(p.stage, moving)}?</strong>
            <span className="muted small">{STAGE_LABEL[p.stage]} → {STAGE_LABEL[moving]}</span>
            {moving === "completed" && openTasks > 0 && (
              <p className="blocked-note">{openTasks} task{openTasks === 1 ? " is" : "s are"} still open. They stay open if you complete the project.</p>
            )}
            {moving === "archived" && <p className="muted small">An archived project is hidden from the sidebar and can't take new tasks. You can restore it later.</p>}
            <textarea aria-label="Note" rows={2} placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            <div className="row-inline">
              <button type="submit" disabled={stage.isPending}>{stage.isPending ? "Saving…" : "Confirm"}</button>
              <button type="button" className="ghost" onClick={() => (setMoving(null), stage.reset())}>Cancel</button>
            </div>
            {stage.error && <p className="alert" role="alert">{stage.error.message}</p>}
          </form>
        )}
      </header>

      <div className="tabbar" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => go({ tab: t })}>{label}</button>
        ))}
      </div>

      {tab === "overview" && <Overview id={id} o={o} refresh={refresh} onOpen={onOpen} />}
      {tab === "work" && <Work project={p as Project} o={o} view={view} views={views} onView={(v) => go({ view: v })} onOpen={onOpen} />}
      {tab === "settings" && <Settings id={id} o={o} refresh={refresh} />}
    </div>
  );
}

function Work({ project, o, view, views, onView, onOpen }: { project: Project; o: ProjectOverview; view: View; views: [View, string][]; onView: (v: View) => void; onOpen: (id: number) => void }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const mine = (tasks.data ?? []).filter((t) => t.project_id === project.id);
  return (
    <div>
      <div className="chip-row" role="group" aria-label="View">
        {views.map(([v, label]) => (
          <button key={v} type="button" className={`chip${view === v ? " on" : ""}`} aria-pressed={view === v} onClick={() => onView(v)}>{label}</button>
        ))}
      </div>
      {view === "queue" && <TicketQueue project={project} onOpen={onOpen} />}
      {view === "list" && <TaskList view="project" embedded onOpen={onOpen} />}
      {view === "board" && <Board project={project} onOpen={onOpen} />}
      {view === "timeline" && <Timeline project={project} tasks={mine} milestones={o.milestones} onOpen={onOpen} />}
    </div>
  );
}

function Overview({ id, o, refresh, onOpen }: { id: number; o: ProjectOverview; refresh: () => Promise<unknown>; onOpen: (id: number) => void }) {
  const { nameOf } = usePeople();
  const g = o.progress;
  const open = g.tasks_total - g.tasks_done;
  const canWrite = o.access.can_write;
  const tasksQ = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const [health, setHealth] = useState<Health>("on_track");
  const [body, setBody] = useState("");

  const post = useMutation({ mutationFn: () => api.postUpdate(id, health, body.trim()), onSuccess: () => (setBody(""), refresh()) });
  const delUpdate = useMutation({ mutationFn: (uid: number) => api.deleteUpdate(id, uid), onSuccess: refresh });
  const error = (post.error ?? delUpdate.error)?.message;
  const today = new Date().toISOString().slice(0, 10);
  const maxWork = Math.max(1, ...o.workload.map((w) => w.open));

  // What to look at first: the numbers' warnings, then the work behind them.
  const nowIso = new Date().toISOString();
  const projectTasks = (tasksQ.data ?? []).filter((t) => t.project_id === id && t.parent_id === null && t.status !== "done");
  const overdue = projectTasks.filter((t) => t.due_at && t.due_at < nowIso).sort((a, b) => a.due_at!.localeCompare(b.due_at!));
  const blocked = projectTasks.filter((t) => t.blocked);
  const unassigned = o.project.workspace_id !== null && o.access.can_manage ? projectTasks.filter((t) => t.assignee_id === null) : [];
  const attentionCount = g.signals.length + (blocked.length ? 1 : 0) + (unassigned.length ? 1 : 0);
  const TaskLink = ({ t }: { t: Task }) => (
    <li><button type="button" className="link" onClick={() => onOpen(t.id)}>{t.title}</button>{t.due_at && <span className="muted small"> · due {new Date(t.due_at).toLocaleDateString()}</span>}</li>
  );
  const differs = g.suggested_health && g.health && g.suggested_health !== g.health;

  return (
    <div>
      {o.pipeline && <ForecastPanel f={o.pipeline} />}
      {o.support && <SupportPanel s={o.support} />}

      <section className={`panel attention${attentionCount ? " warn" : ""}`} aria-label="Needs attention">
        <h2>
          {attentionCount ? <><AlertTriangle size={16} /> Needs attention</> : "On track"}
          {g.suggested_health && <HealthBadge health={g.suggested_health} />}
        </h2>
        {attentionCount === 0 && <p className="muted small">Nothing is overdue, blocked or running behind. The numbers see no problems.</p>}
        {g.signals.length > 0 && <ul className="signals">{g.signals.map((s) => <li key={s.code}>{s.text}</li>)}</ul>}
        {differs && (
          <p className="muted small">
            The team rated it <strong>{HEALTH_LABEL[g.health!]}</strong>, while the numbers suggest <strong>{HEALTH_LABEL[g.suggested_health!]}</strong>. Post an update to say why, or to change the rating.
          </p>
        )}
        {overdue.length > 0 && (
          <>
            <h3>Overdue</h3>
            <ul className="attention-list">{overdue.slice(0, 5).map((t) => <TaskLink key={t.id} t={t} />)}</ul>
            {overdue.length > 5 && <p className="muted small">and {overdue.length - 5} more</p>}
          </>
        )}
        {blocked.length > 0 && (
          <>
            <h3>Blocked by unfinished work</h3>
            <ul className="attention-list">{blocked.slice(0, 5).map((t) => <TaskLink key={t.id} t={t} />)}</ul>
          </>
        )}
        {unassigned.length > 0 && (
          <>
            <h3>Nobody is assigned</h3>
            <ul className="attention-list">{unassigned.slice(0, 5).map((t) => <TaskLink key={t.id} t={t} />)}</ul>
            {unassigned.length > 5 && <p className="muted small">and {unassigned.length - 5} more</p>}
          </>
        )}
      </section>

      <div className="pm-stats">
        <div className="stat">
          <span title="Done work as a share of all work. Tasks are weighted by their estimate; one without an estimate counts as an hour.">Progress</span>
          <strong>{g.progress_pct}%<small> · {g.tasks_done}/{g.tasks_total} tasks</small></strong>
          <ProgressBar done={g.progress_pct} total={100} label="Work done" />
        </div>
        <div className="stat"><span>Open</span><strong>{open}</strong></div>
        <div className="stat"><span>Overdue</span><strong className={g.tasks_overdue ? "overdue" : ""}>{g.tasks_overdue}</strong></div>
        <div className="stat">
          <span>Time</span>
          <strong>{formatMinutes(o.time.tracked_min)}<small>{o.time.estimate_min ? ` / ${formatMinutes(o.time.estimate_min)} est.` : ""}</small></strong>
        </div>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}

      <div className="pm-grid">
        <MilestonePanel
          projectId={id}
          workspaceId={o.project.workspace_id}
          milestones={o.milestones}
          canWrite={canWrite}
          canSignOff={o.access.can_sign_off}
          currency={o.project.currency}
          refresh={refresh}
          onOpenTask={onOpen}
        />

        <section className="panel" aria-label="Tasks by status">
          <h2>By status</h2>
          <ul className="bar-list">
            {o.by_status.map((s) => (
              <li key={s.name} style={{ ["--c" as string]: s.color }}>
                <span>{s.name}</span>
                <span className="hbar"><span style={{ width: `${percent(s.count, g.tasks_total)}%` }} /></span>
                <span className="n">{s.count}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel" aria-label="Workload">
          <h2>Open work by person</h2>
          {o.workload.length === 0 && <p className="muted small">Nothing open.</p>}
          <ul className="bar-list">
            {o.workload.map((w) => (
              <li key={w.assignee_id ?? "none"}>
                <span>{w.assignee_id === null ? "Unassigned" : nameOf(w.assignee_id)}</span>
                <span className="hbar"><span style={{ width: `${percent(w.open, maxWork)}%` }} /></span>
                <span className="n">{w.open}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel span-2" aria-label="Status updates">
          <h2>Updates</h2>
          {canWrite && (
            <form onSubmit={(e) => (e.preventDefault(), post.mutate())} style={{ display: "grid", gap: 8 }}>
              <div className="chip-row" role="radiogroup" aria-label="Health" style={{ marginBottom: 0 }}>
                {(Object.keys(HEALTH_LABEL) as Health[]).map((h) => (
                  <button key={h} type="button" role="radio" aria-checked={health === h} className={`chip${health === h ? " on" : ""}`} onClick={() => setHealth(h)}>
                    {HEALTH_LABEL[h]}
                  </button>
                ))}
              </div>
              <textarea aria-label="Update" rows={2} placeholder="How is it going? (optional)" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
              <div><button type="submit" disabled={post.isPending}>Post update</button></div>
            </form>
          )}
          {o.updates.length === 0 && <p className="muted small">No updates yet.</p>}
          <ul className="timeline">
            {o.updates.map((u) => (
              <li key={u.id}>
                <span className="when">
                  {u.kind === "update" ? <HealthBadge health={u.health} /> : <>Moved to <StageBadge stage={u.stage!} /></>} · {u.author} · {timeAgo(u.created_at)}
                  {u.kind === "update" && (canWrite || o.access.can_manage) && (
                    <button type="button" className="icon sm" aria-label="Delete update" onClick={() => confirm("Delete this update?") && delUpdate.mutate(u.id)}><Trash2 size={13} /></button>
                  )}
                </span>
                {u.body && <span className="body">{u.body}</span>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Settings({ id, o, refresh }: { id: number; o: ProjectOverview; refresh: () => Promise<unknown> }) {
  const p = o.project;
  const ws = useQuery({ queryKey: ["workspace", p.workspace_id], queryFn: () => api.workspace(p.workspace_id!), enabled: p.workspace_id !== null });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const initial = { name: p.name, color: p.color, type: p.type as ProjectType, description: p.description, lead_id: p.lead_id, start_date: p.start_date ?? "", target_date: p.target_date ?? "", currency: p.currency, reply_hours: p.first_response_hours === null ? "" : String(p.first_response_hours), resolve_hours: p.resolution_hours === null ? "" : String(p.resolution_hours) };
  const [f, setF] = useState(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => setF(initial), [p.name, p.color, p.type, p.description, p.lead_id, p.start_date, p.target_date, p.currency, p.first_response_hours, p.resolution_hours]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () => api.updateProject(id, { name: f.name.trim(), color: f.color, type: f.type, description: f.description, lead_id: f.lead_id, start_date: f.start_date || null, target_date: f.target_date || null, currency: f.currency.trim().toUpperCase() || "USD", first_response_hours: f.reply_hours ? Number(f.reply_hours) : null, resolution_hours: f.resolve_hours ? Number(f.resolve_hours) : null }),
    onSuccess: () => (setSaved(true), refresh()),
  });
  const canManage = o.access.can_manage;
  const leads = p.workspace_id === null ? (me ? [{ id: me.id, name: `${me.name} (you)` }] : []) : (ws.data?.members ?? []).filter((m) => m.role !== "viewer");
  const wsName = workspaces.data?.find((w) => w.id === p.workspace_id)?.name;
  const badDates = !!f.start_date && !!f.target_date && f.target_date < f.start_date;
  const set = (patch: Partial<typeof f>) => (setSaved(false), setF({ ...f, ...patch }));

  return (
    <div>
      <section className="panel" aria-label="Project details">
        <h2>Details</h2>
        <form className="settings-form" onSubmit={(e) => (e.preventDefault(), !badDates && f.name.trim() && save.mutate())}>
          <fieldset className="bare" disabled={!canManage} style={{ display: "grid", gap: 12 }}>
            <div className="two">
              <label>Name<input value={f.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} /></label>
              <label>Colour<input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} /></label>
            </div>
            <label>
              Type
              <select value={f.type} onChange={(e) => set({ type: e.target.value as ProjectType })}>
                {PROJECT_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_INFO[t].label}</option>
                ))}
              </select>
              <span className="muted small" style={{ fontWeight: 400 }}>{TYPE_INFO[f.type].blurb} The type sets the view the Work tab opens on; change statuses below.</span>
            </label>
            <label>Description<textarea rows={3} value={f.description} maxLength={5000} placeholder="What is this project for?" onChange={(e) => set({ description: e.target.value })} /></label>
            <label>
              Project lead
              <select value={f.lead_id ?? ""} onChange={(e) => set({ lead_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">No lead</option>
                {leads.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <div className="two">
              <label>Start date<input type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} /></label>
              <label>Target date<input type="date" value={f.target_date} onChange={(e) => set({ target_date: e.target.value })} /></label>
            </div>
            {badDates && <p className="alert" role="alert">The target date can't be before the start date.</p>}
            {f.type === "pipeline" && (
              <label>
                Currency
                <input aria-label="Currency" value={f.currency} maxLength={3} placeholder="USD" style={{ width: 90, textTransform: "uppercase" }} onChange={(e) => set({ currency: e.target.value })} />
                <span className="muted small" style={{ fontWeight: 400 }}>Three letters, such as USD, EUR or AED. Used to show deal values.</span>
              </label>
            )}
            {f.type === "support" && (
              <div className="two">
                <label>
                  Reply to customers within (hours)
                  <input type="number" min={1} max={8760} aria-label="First reply target hours" value={f.reply_hours} placeholder="No target" onChange={(e) => set({ reply_hours: e.target.value })} />
                </label>
                <label>
                  Resolve within (hours)
                  <input type="number" min={1} max={8760} aria-label="Resolution target hours" value={f.resolve_hours} placeholder="No target" onChange={(e) => set({ resolve_hours: e.target.value })} />
                </label>
              </div>
            )}
          </fieldset>
          {canManage ? (
            <div className="row-inline">
              <button type="submit" disabled={save.isPending || badDates || !f.name.trim()}>{save.isPending ? "Saving…" : "Save changes"}</button>
              {saved && <span className="muted small" role="status">Saved</span>}
            </div>
          ) : (
            <p className="muted small">Only the project's managers can change these details.</p>
          )}
          {save.error && <p className="alert" role="alert">{save.error.message}</p>}
        </form>
      </section>

      <section className="panel" aria-label="Task statuses">
        <h2>Task statuses</h2>
        <StatusManager scope={{ project_id: id }} canManage={canManage} showProbability={p.type === "pipeline"} inheritedFrom={wsName ? `the ${wsName} workspace` : undefined} />
      </section>

      {o.intake && (
        <section className="panel" aria-label="Customer intake">
          <h2>Customer intake</h2>
          <IntakeSettings projectId={id} intake={o.intake} onChanged={() => void refresh()} />
        </section>
      )}
    </div>
  );
}
