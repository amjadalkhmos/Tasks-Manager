import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react";
import { api, type Health, type ProjectOverview, type Stage } from "../api";
import { HealthBadge, ProgressBar, StageBadge } from "../components/ProjectBadges";
import { StatusManager } from "../components/StatusManager";
import { describeDeadline, formatDay, percent, transitionLabel } from "../lib/projects";
import { usePeople } from "../lib/people";
import { formatMinutes } from "../lib/tasks";
import { timeAgo } from "../lib/time";
import { HEALTH_LABEL, STAGE_LABEL } from "../lib/projects";
import { TaskList } from "./TaskList";

type Tab = "tasks" | "overview" | "settings";
const TABS: [Tab, string][] = [["tasks", "Tasks"], ["overview", "Overview"], ["settings", "Settings"]];

export function ProjectPage({ onOpen }: { onOpen: (id: number) => void }) {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? "tasks") as Tab;
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
  const setTab = (t: Tab) => setParams(t === "tasks" ? {} : { tab: t }, { replace: true });

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
        <div className="facts">
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
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === "tasks" && <TaskList view="project" embedded onOpen={onOpen} />}
      {tab === "overview" && <Overview id={id} o={o} refresh={refresh} />}
      {tab === "settings" && <Settings id={id} o={o} refresh={refresh} />}
    </div>
  );
}

function Overview({ id, o, refresh }: { id: number; o: ProjectOverview; refresh: () => Promise<unknown> }) {
  const { nameOf } = usePeople();
  const g = o.progress;
  const open = g.tasks_total - g.tasks_done;
  const canWrite = o.access.can_write;
  const [msName, setMsName] = useState("");
  const [msDue, setMsDue] = useState("");
  const [health, setHealth] = useState<Health>("on_track");
  const [body, setBody] = useState("");

  const addMs = useMutation({ mutationFn: () => api.addMilestone(id, msName.trim(), msDue || null), onSuccess: () => (setMsName(""), setMsDue(""), refresh()) });
  const toggleMs = useMutation({ mutationFn: ({ mid, done }: { mid: number; done: boolean }) => api.updateMilestone(mid, { done }), onSuccess: refresh });
  const delMs = useMutation({ mutationFn: api.deleteMilestone, onSuccess: refresh });
  const post = useMutation({ mutationFn: () => api.postUpdate(id, health, body.trim()), onSuccess: () => (setBody(""), refresh()) });
  const delUpdate = useMutation({ mutationFn: (uid: number) => api.deleteUpdate(id, uid), onSuccess: refresh });
  const error = (addMs.error ?? toggleMs.error ?? delMs.error ?? post.error ?? delUpdate.error)?.message;
  const today = new Date().toISOString().slice(0, 10);
  const maxWork = Math.max(1, ...o.workload.map((w) => w.open));

  return (
    <div>
      <div className="pm-stats">
        <div className="stat">
          <span>Progress</span>
          <strong>{percent(g.tasks_done, g.tasks_total)}%<small> · {g.tasks_done}/{g.tasks_total}</small></strong>
          <ProgressBar done={g.tasks_done} total={g.tasks_total} label="Tasks done" />
        </div>
        <div className="stat"><span>Open</span><strong>{open}</strong></div>
        <div className="stat"><span>Overdue</span><strong className={g.tasks_overdue ? "overdue" : ""}>{g.tasks_overdue}</strong></div>
        <div className="stat">
          <span>Time</span>
          <strong>{formatMinutes(o.time.tracked_min)}<small>{o.time.estimate_min ? ` / ${formatMinutes(o.time.estimate_min)} est.` : ""}</small></strong>
        </div>
      </div>
      {g.tasks_blocked > 0 && <p className="muted small" style={{ marginBottom: 12 }}>{g.tasks_blocked} open task{g.tasks_blocked === 1 ? " is" : "s are"} blocked by unfinished work.</p>}
      {error && <p className="alert" role="alert">{error}</p>}

      <div className="pm-grid">
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

        <section className="panel" aria-label="Milestones">
          <h2>Milestones {g.milestones_total > 0 && <span className="muted small">{g.milestones_done}/{g.milestones_total}</span>}</h2>
          {o.milestones.length === 0 && <p className="muted small">No milestones yet. Add the dates that matter.</p>}
          <ul className="milestones">
            {o.milestones.map((m) => (
              <li key={m.id} className={m.completed_at ? "done" : ""}>
                <input type="checkbox" checked={!!m.completed_at} disabled={!canWrite} aria-label={`Done: ${m.name}`} onChange={() => toggleMs.mutate({ mid: m.id, done: !m.completed_at })} />
                <span className="name">{m.name}</span>
                {m.due_date && <span className={`muted small${!m.completed_at && m.due_date < today ? " late" : ""}`}>{formatDay(m.due_date)}</span>}
                {canWrite && (
                  <button type="button" className="icon sm" aria-label={`Remove ${m.name}`} onClick={() => delMs.mutate(m.id)}><X size={14} /></button>
                )}
              </li>
            ))}
          </ul>
          {canWrite && (
            <form className="add-line" onSubmit={(e) => (e.preventDefault(), msName.trim() && addMs.mutate())}>
              <input aria-label="New milestone" placeholder="Add a milestone…" value={msName} maxLength={200} onChange={(e) => setMsName(e.target.value)} />
              <input type="date" aria-label="Milestone date" value={msDue} onChange={(e) => setMsDue(e.target.value)} />
              <button type="submit" className="secondary" disabled={!msName.trim() || addMs.isPending}>Add</button>
            </form>
          )}
        </section>

        <section className="panel" aria-label="Status updates">
          <h2>Updates</h2>
          {canWrite && (
            <form onSubmit={(e) => (e.preventDefault(), post.mutate())} style={{ display: "grid", gap: 8 }}>
              <div className="chip-row" role="radiogroup" aria-label="Health">
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
  const [f, setF] = useState({ name: p.name, color: p.color, description: p.description, lead_id: p.lead_id, start_date: p.start_date ?? "", target_date: p.target_date ?? "" });
  const [saved, setSaved] = useState(false);
  useEffect(() => setF({ name: p.name, color: p.color, description: p.description, lead_id: p.lead_id, start_date: p.start_date ?? "", target_date: p.target_date ?? "" }), [p.name, p.color, p.description, p.lead_id, p.start_date, p.target_date]);

  const save = useMutation({
    mutationFn: () => api.updateProject(id, { name: f.name.trim(), color: f.color, description: f.description, lead_id: f.lead_id, start_date: f.start_date || null, target_date: f.target_date || null }),
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
        <StatusManager scope={{ project_id: id }} canManage={canManage} inheritedFrom={wsName ? `the ${wsName} workspace` : undefined} />
      </section>
    </div>
  );
}
