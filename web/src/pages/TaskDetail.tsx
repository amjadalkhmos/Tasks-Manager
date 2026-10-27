import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, Bell, CalendarDays, CircleDot, Eye, Flag, Folder, Hash, History, Lock, Play, Plus, Repeat, Sparkles, Square, Timer, Trash2, UserCheck, X } from "lucide-react";
import { api, type Recurrence, type Task } from "../api";
import { Avatar } from "../components/Avatar";
import { Comments } from "../components/Comments";
import { MeetingDrawer } from "../components/MeetingDrawer";
import { TaskMeetings } from "../components/TaskMeetings";
import { describeActivity } from "../lib/activity";
import { usePeople } from "../lib/people";
import { clockText } from "../lib/sla";
import { SlaBadge } from "../components/SlaBadge";
import { statusOf, useStatuses } from "../lib/statuses";
import { fromLocalInput, toLocalInput } from "../lib/datetime";
import { formatMinutes } from "../lib/tasks";
import { timeAgo } from "../lib/time";
import { useTaskActions } from "../lib/useTaskActions";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

interface TreeProps {
  parentId: number;
  all: Task[];
  depth: number;
  onOpen: (id: number) => void;
  onToggle: (t: Task) => void;
  onAdd: (parentId: number, title: string) => void;
  readOnly?: boolean;
}

/** Subtasks of `parentId`, recursively, each level with its own "add subtask" control. */
function SubtaskTree({ parentId, all, depth, onOpen, onToggle, onAdd, readOnly }: TreeProps) {
  const children = all.filter((t) => t.parent_id === parentId);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  return (
    <>
      <ul className="tasks compact">
        {children.map((s) => (
          <li key={s.id} className={`has-children${s.status === "done" ? " done" : ""}`} data-priority={s.priority}>
            <input
              type="checkbox"
              checked={s.status === "done"}
              disabled={readOnly || (s.blocked && s.status !== "done")}
              onChange={() => onToggle(s)}
              aria-label={`Complete ${s.title}`}
            />
            <button className="title" onClick={() => onOpen(s.id)}>{s.title}</button>
            {s.subtasks_total > 0 && <span className="muted small">{s.subtasks_done}/{s.subtasks_total}</span>}
            <div className="children subtree">
              <SubtaskTree parentId={s.id} all={all} depth={depth + 1} onOpen={onOpen} onToggle={onToggle} onAdd={onAdd} readOnly={readOnly} />
            </div>
          </li>
        ))}
      </ul>
      {readOnly ? null : adding ? (
        <form
          className="add-line"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) onAdd(parentId, title.trim());
            setTitle("");
            setAdding(false);
          }}
        >
          <input
            autoFocus
            placeholder="Subtask…"
            aria-label="Subtask title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => !title && setAdding(false)}
          />
        </form>
      ) : (
        <button type="button" className="ghost add-sub" onClick={() => setAdding(true)}>
          <Plus size={14} /> Add subtask
        </button>
      )}
    </>
  );
}

function Prop({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="prop">
      <span className="k">{icon}{label}</span>
      <div className="v">{children}</div>
    </div>
  );
}

export function TaskDetail({ id, onClose, onOpen }: { id: number; onClose: () => void; onOpen: (id: number) => void }) {
  const actions = useTaskActions();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const checklist = useQuery({ queryKey: ["checklist", id], queryFn: () => api.checklist(id) });
  const all = tasks.data ?? [];
  const task = all.find((t) => t.id === id);
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const { nameOf } = usePeople();
  const wsId = task?.workspace_id ?? null;
  const wsDetail = useQuery({ queryKey: ["workspace", wsId], queryFn: () => api.workspace(wsId!), enabled: wsId !== null });
  const [showHistory, setShowHistory] = useState(false);
  const [editMeeting, setEditMeeting] = useState<number | null>(null);
  const history = useQuery({ queryKey: ["task-activity", id], queryFn: () => api.taskActivity(id), enabled: showHistory && wsId !== null });

  const [draft, setDraft] = useState<Task | null>(null);
  const [tagText, setTagText] = useState("");
  const [checkText, setCheckText] = useState("");
  const [depId, setDepId] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const aiStatus = useQuery({ queryKey: ["ai-status"], queryFn: api.aiStatus, staleTime: 5 * 60_000 });
  const suggest = useMutation({
    mutationFn: () => api.suggestSubtasks(id),
    onSuccess: ({ subtasks }) => setPicked(Object.fromEntries(subtasks.map((t) => [t, true]))),
  });

  // Reset the draft only when switching tasks, so background refetches don't clobber typing.
  useEffect(() => {
    if (task && draft?.id !== task.id) {
      setDraft(task);
      setTagText(task.tags.join(", "));
    }
  }, [task, draft?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statuses = useStatuses();
  const planProject = task && draft && draft.project_id === task.project_id ? task.project_id : null;
  const plan = useQuery({ queryKey: ["overview", planProject], queryFn: () => api.overview(planProject!), enabled: planProject !== null, retry: false });
  const save = useMutation({
    mutationFn: async (d: Task) => {
      // Only send the status when it was changed here and the task stays where it is; after a move the server picks one.
      const statusChanged = task && d.project_id === task.project_id && (d.status !== task.status || d.status_id !== task.status_id);
      const becomesDone = !!statusChanged && d.status === "done" && task!.status !== "done";
      await api.updateTask(d.id, {
        ...(statusChanged && !becomesDone ? (d.status_id !== null ? { status_id: d.status_id } : { status: d.status, status_id: null }) : {}),
        ...(task && d.project_id === task.project_id && d.milestone_id !== task.milestone_id ? { milestone_id: d.milestone_id } : {}),
        start_at: d.start_at,
        value: d.value,
        requester_name: d.requester_name?.trim() || null,
        requester_email: d.requester_email?.trim() || null,
        title: d.title,
        notes: d.notes,
        priority: d.priority,
        project_id: d.project_id,
        assignee_id: d.assignee_id,
        due_at: d.due_at,
        remind_at: d.remind_at,
        recurrence: d.recurrence,
        estimate_min: d.estimate_min,
        tags: tagText.split(",").map((s) => s.trim()).filter(Boolean),
      });
      // Finishing goes through "complete" so a recurring task spawns its next occurrence.
      if (becomesDone) await api.completeTask(d.id, d.status_id ?? undefined);
    },
    onSuccess: () => actions.refresh().then(onClose),
  });
  const respond = useMutation({ mutationFn: () => api.respond(id), onSuccess: actions.refresh });
  const remove = useMutation({ mutationFn: () => api.deleteTask(id), onSuccess: () => actions.refresh().then(onClose) });
  const addSub = useMutation({
    mutationFn: ({ parentId, title }: { parentId: number; title: string }) =>
      api.createTask({ title, parent_id: parentId, project_id: task?.project_id ?? null }),
    onSuccess: actions.refresh,
  });
  const addCheck = useMutation({
    mutationFn: (text: string) => api.addCheckItem(id, text),
    onSuccess: () => (setCheckText(""), actions.refresh()),
  });
  const toggleCheck = useMutation({
    mutationFn: (i: { id: number; done: boolean }) => api.updateCheckItem(i.id, { done: i.done }),
    onSuccess: actions.refresh,
  });
  const delCheck = useMutation({ mutationFn: api.deleteCheckItem, onSuccess: actions.refresh });
  const addDep = useMutation({
    mutationFn: (blockedBy: number) => api.addDep(id, blockedBy),
    onSuccess: () => (setDepId(""), actions.refresh()),
  });
  const addPicked = useMutation({
    mutationFn: async () => {
      for (const title of Object.keys(picked).filter((t) => picked[t]))
        await api.createTask({ title, parent_id: id, project_id: task?.project_id ?? null });
    },
    onSuccess: () => (suggest.reset(), setPicked({}), actions.refresh()),
  });
  const removeDep = useMutation({ mutationFn: (blockedBy: number) => api.removeDep(id, blockedBy), onSuccess: actions.refresh });
  const timer = useMutation({
    mutationFn: () => (task?.timer_running ? api.stopTimer() : api.startTimer(id)),
    onSuccess: actions.refresh,
  });

  if (!task || !draft) return null;
  const patch = (p: Partial<Task>) => setDraft({ ...draft, ...p });
  const rec = draft.recurrence;
  const setRec = (r: Recurrence | null) => patch({ recurrence: r });
  // Prerequisites must live in the same place (same workspace, or both private) and be editable by this person.
  const depCandidates = all.filter((t) => t.id !== id && t.status !== "done" && !task.blocked_by.includes(t.id) && t.workspace_id === task.workspace_id && t.access !== "read");
  const readOnly = task.access === "read";
  const draftType = (projects.data ?? []).find((p) => p.id === draft.project_id)?.type;
  const draftWorkspace = (projects.data ?? []).find((p) => p.id === draft.project_id)?.workspace_id ?? null;
  const placeStatuses = statuses.forPlace(draft.project_id, draftWorkspace);
  const members = wsDetail.data?.members ?? [];
  const assignable = members.filter((m) => m.role !== "viewer");
  // Archived projects don't take tasks (unless the task is already in one).
  const pickable = (p: { id: number; stage: string }) => p.stage !== "archived" || p.id === draft.project_id;
  const personalProjects = (projects.data ?? []).filter((p) => p.workspace_id === null && pickable(p));
  const error = (save.error ?? addDep.error ?? addSub.error ?? remove.error)?.message ?? actions.error;
  const parent = task.parent_id !== null ? all.find((t) => t.id === task.parent_id) : undefined;

  return (
    <div className="backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Task details">
        <div className="drawer-head">
          {task.parent_id !== null ? (
            <button className="parent-link" onClick={() => onOpen(task.parent_id!)}>
              <ArrowUp size={14} /> {parent?.title ?? "Parent task"}
            </button>
          ) : (
            <span className="muted small">Task</span>
          )}
          <button className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="drawer-body">
          {task.blocked && (
            <p className="blocked-note"><Lock size={15} />Blocked until its prerequisites are done.</p>
          )}
          {readOnly && <p className="blocked-note view-only"><Eye size={15} />View only. You can read this task but not change it.</p>}
          {task.ticket_no !== null && (
            <section className="ticket-box" aria-label="Support ticket">
              <div className="ticket-head">
                <strong>Ticket #{task.ticket_no}</strong>
                <span className="muted small">
                  {task.source === "form" ? "via the support form" : task.source === "email" ? "via email" : "logged by the team"}
                </span>
              </div>
              {(task.requester_name || task.requester_email) && (
                <p className="small">
                  {task.requester_name}
                  {task.requester_email && <> · <a href={`mailto:${task.requester_email}?subject=${encodeURIComponent(`Re: ${task.title} [#${task.ticket_no}]`)}`}>{task.requester_email}</a></>}
                </p>
              )}
              <div className="ticket-clocks">
                {task.sla?.response && <SlaBadge clock={clockText("Reply", task.sla.response)} />}
                {task.sla?.resolution && <SlaBadge clock={clockText("Resolution", task.sla.resolution)} />}
                {!task.first_response_at && !readOnly && (
                  <button type="button" className="secondary sm" disabled={respond.isPending} onClick={() => respond.mutate()}>Mark first response</button>
                )}
                {task.first_response_at && <span className="muted small">Answered {new Date(task.first_response_at).toLocaleString()}</span>}
              </div>
              <p className="muted small">Replies from the customer by email appear in the comments below. Reply to them from your own mailbox, keeping “[#{task.ticket_no}]” in the subject so it joins this ticket.</p>
            </section>
          )}
          <input className="title-input" aria-label="Title" readOnly={readOnly} value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
          <textarea
            className="notes-input"
            aria-label="Notes"
            readOnly={readOnly}
            placeholder={readOnly ? "" : "Add notes…"}
            rows={3}
            value={draft.notes}
            onChange={(e) => patch({ notes: e.target.value })}
          />

          <fieldset className="bare" disabled={readOnly}>
          <div className="props">
            <Prop icon={<Flag size={15} />} label="Priority">
              <select aria-label="Priority" value={draft.priority} onChange={(e) => patch({ priority: Number(e.target.value) })}>
                <option value={0}>None</option>
                <option value={1}>Low</option>
                <option value={2}>Medium</option>
                <option value={3}>High</option>
              </select>
            </Prop>
            <Prop icon={<CircleDot size={15} />} label="Status">
              <select
                aria-label="Status"
                value={statusOf(placeStatuses, draft).id ?? `c:${draft.status}`}
                onChange={(e) => {
                  const o = placeStatuses.find((s) => String(s.id ?? `c:${s.category}`) === e.target.value)!;
                  patch({ status: o.category, status_id: o.id });
                }}
              >
                {placeStatuses.map((s) => (
                  <option key={String(s.id ?? s.category)} value={s.id ?? `c:${s.category}`}>{s.name}</option>
                ))}
              </select>
            </Prop>
            <Prop icon={<Folder size={15} />} label="Project">
              <select
                aria-label="Project"
                value={draft.project_id ?? ""}
                onChange={(e) => patch({ project_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Inbox (private)</option>
                {personalProjects.length > 0 && (
                  <optgroup label="Private projects">
                    {personalProjects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                )}
                {workspaces.data?.map((w) => (
                  <optgroup key={w.id} label={`${w.name} (shared)`}>
                    {(projects.data ?? []).filter((p) => p.workspace_id === w.id && pickable(p)).map((p) => (
                      <option key={p.id} value={p.id} disabled={w.role === "viewer"}>{p.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Prop>
            {planProject !== null && (plan.data?.milestones.length ?? 0) > 0 && (
              <Prop icon={<Flag size={15} />} label="Milestone">
                <select aria-label="Milestone" value={draft.milestone_id ?? ""} onChange={(e) => patch({ milestone_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">None</option>
                  {plan.data!.milestones.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}{m.due_date ? ` · ${m.due_date}` : ""}</option>
                  ))}
                </select>
              </Prop>
            )}
            {task.workspace_id !== null && (
              <Prop icon={<UserCheck size={15} />} label="Assignee">
                <select
                  aria-label="Assignee"
                  value={draft.assignee_id ?? ""}
                  onChange={(e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Unassigned</option>
                  {assignable.map((m) => (
                    <option key={m.id} value={m.id}>{m.id === me?.id ? `${m.name} (you)` : m.name}</option>
                  ))}
                </select>
              </Prop>
            )}
            <Prop icon={<CalendarDays size={15} />} label="Start">
              <input type="datetime-local" aria-label="Start" value={toLocalInput(draft.start_at)} onChange={(e) => patch({ start_at: fromLocalInput(e.target.value) })} />
            </Prop>
            {draftType === "pipeline" && (
              <Prop icon={<Flag size={15} />} label="Deal value">
                <input type="number" min={0} step="any" aria-label="Deal value" value={draft.value ?? ""} onChange={(e) => patch({ value: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })} />
              </Prop>
            )}
            {draftType === "support" && (
              <>
                <Prop icon={<UserCheck size={15} />} label="Requester">
                  <input aria-label="Requester name" placeholder="Name" value={draft.requester_name ?? ""} maxLength={100} onChange={(e) => patch({ requester_name: e.target.value })} />
                </Prop>
                <Prop icon={<Hash size={15} />} label="Requester email">
                  <input type="email" aria-label="Requester email" placeholder="name@example.com" value={draft.requester_email ?? ""} maxLength={200} onChange={(e) => patch({ requester_email: e.target.value })} />
                </Prop>
              </>
            )}
            <Prop icon={<CalendarDays size={15} />} label={draftType === "pipeline" ? "Expected close" : "Due"}>
              <input type="datetime-local" aria-label="Due" value={toLocalInput(draft.due_at)} onChange={(e) => patch({ due_at: fromLocalInput(e.target.value) })} />
            </Prop>
            <Prop icon={<Bell size={15} />} label="Remind me">
              <input type="datetime-local" aria-label="Remind me" value={toLocalInput(draft.remind_at)} onChange={(e) => patch({ remind_at: fromLocalInput(e.target.value) })} />
            </Prop>
            <Prop icon={<Hash size={15} />} label="Tags">
              <input aria-label="Tags" placeholder="comma, separated" value={tagText} onChange={(e) => setTagText(e.target.value)} />
            </Prop>
            <Prop icon={<Repeat size={15} />} label="Repeat">
              <select
                aria-label="Repeat"
                value={rec?.freq ?? ""}
                onChange={(e) =>
                  setRec(e.target.value ? { freq: e.target.value as Recurrence["freq"], interval: rec?.interval ?? 1 } : null)
                }
              >
                <option value="">Never</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {rec && (
                <label className="inline">
                  every
                  <input
                    type="number"
                    min={1}
                    max={365}
                    aria-label="Repeat interval"
                    value={rec.interval}
                    onChange={(e) => setRec({ ...rec, interval: Math.max(1, Number(e.target.value) || 1) })}
                  />
                </label>
              )}
              {rec?.freq === "weekly" && (
                <div className="weekdays">
                  {WEEKDAYS.map((label, i) => {
                    const on = rec.weekdays?.includes(i) ?? false;
                    return (
                      <button
                        type="button"
                        key={label}
                        className={on ? "chip on" : "chip"}
                        aria-pressed={on}
                        onClick={() => {
                          const next = on ? rec.weekdays!.filter((d) => d !== i) : [...(rec.weekdays ?? []), i];
                          setRec({ ...rec, weekdays: next.length ? next : undefined });
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
              {rec && !draft.due_at && <span className="muted small" style={{ flexBasis: "100%" }}>No due date yet — repeats from the completion date.</span>}
            </Prop>
            <Prop icon={<Timer size={15} />} label="Time">
              <input
                type="number"
                min={0}
                aria-label="Estimate in minutes"
                placeholder="Estimate (min)"
                value={draft.estimate_min ?? ""}
                onChange={(e) => patch({ estimate_min: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
              />
              <span className="muted small">Tracked {formatMinutes(task.tracked_min)}</span>
              <button type="button" className="secondary" onClick={() => timer.mutate()} disabled={timer.isPending}>
                {task.timer_running ? <Square size={13} /> : <Play size={13} />}
                {task.timer_running ? "Stop timer" : "Start timer"}
              </button>
            </Prop>
          </div>
          </fieldset>

          <section className="panel-section">
            <h3>
              Subtasks {task.subtasks_total > 0 && <span className="count">{task.subtasks_done}/{task.subtasks_total}</span>}
              {aiStatus.data?.enabled && !suggest.data && !readOnly && (
                <button type="button" className="ghost suggest-btn" disabled={suggest.isPending} onClick={() => suggest.mutate()}>
                  <Sparkles size={14} /> {suggest.isPending ? "Thinking…" : "Suggest subtasks"}
                </button>
              )}
            </h3>
            {suggest.error && <p className="alert" role="alert">{suggest.error.message}</p>}
            {suggest.data && (
              <div className="suggestions" role="group" aria-label="Suggested subtasks">
                {suggest.data.subtasks.length === 0 ? (
                  <p className="muted small">This already looks small enough to do in one go.</p>
                ) : (
                  <>
                    <p className="muted small"><Sparkles size={13} /> Suggested by AI. Untick any you don't want.</p>
                    <ul className="tasks compact">
                      {suggest.data.subtasks.map((t) => (
                        <li key={t}>
                          <input type="checkbox" className="square" checked={!!picked[t]} aria-label={t} onChange={() => setPicked({ ...picked, [t]: !picked[t] })} />
                          <span className="title" style={{ padding: "4px 0" }}>{t}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="row-inline">
                  {suggest.data.subtasks.length > 0 && (
                    <button type="button" disabled={addPicked.isPending || !Object.values(picked).some(Boolean)} onClick={() => addPicked.mutate()}>
                      Add {Object.values(picked).filter(Boolean).length} subtask{Object.values(picked).filter(Boolean).length === 1 ? "" : "s"}
                    </button>
                  )}
                  <button type="button" className="ghost" onClick={() => (suggest.reset(), setPicked({}))}>Dismiss</button>
                </div>
                {addPicked.error && <p className="alert" role="alert">{addPicked.error.message}</p>}
              </div>
            )}
            <SubtaskTree
              parentId={id}
              all={all}
              depth={0}
              onOpen={onOpen}
              onToggle={actions.toggle}
              onAdd={(parentId, title) => addSub.mutate({ parentId, title })}
              readOnly={readOnly}
            />
          </section>

          <section className="panel-section">
            <h3>Checklist {task.checklist_total > 0 && <span className="count">{task.checklist_done}/{task.checklist_total}</span>}</h3>
            <ul className="tasks compact">
              {checklist.data?.map((i) => (
                <li key={i.id} className={i.done ? "done" : ""}>
                  <input type="checkbox" checked={i.done} disabled={readOnly} aria-label={i.text} onChange={() => toggleCheck.mutate({ id: i.id, done: !i.done })} />
                  <span className="title" style={{ padding: "4px 0" }}>{i.text}</span>
                  <button type="button" className="icon sm" disabled={readOnly} aria-label={`Remove ${i.text}`} onClick={() => delCheck.mutate(i.id)}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
            {!readOnly && (
              <form
                className="add-line"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (checkText.trim()) addCheck.mutate(checkText.trim());
                }}
              >
                <input placeholder="Add checklist item…" aria-label="Add checklist item" value={checkText} onChange={(e) => setCheckText(e.target.value)} />
              </form>
            )}
          </section>

          <TaskMeetings task={task} readOnly={readOnly} onEdit={setEditMeeting} />

          <section className="panel-section">
            <h3>Blocked by</h3>
            <ul className="tasks compact">
              {task.blocked_by.map((b) => {
                const dep = all.find((t) => t.id === b);
                return (
                  <li key={b} className={dep?.status === "done" ? "done" : ""}>
                    <Lock size={14} className="muted" />
                    <button className="title" onClick={() => onOpen(b)}>{dep?.title ?? `Task #${b}`}</button>
                    <button type="button" className="icon sm" disabled={readOnly} aria-label="Remove dependency" onClick={() => removeDep.mutate(b)}>
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {!readOnly && <div className="add-line">
              <select value={depId} onChange={(e) => setDepId(e.target.value)} aria-label="Add prerequisite">
                <option value="">Add prerequisite…</option>
                {depCandidates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
              <button type="button" className="secondary" disabled={!depId} onClick={() => addDep.mutate(Number(depId))}>Add</button>
            </div>}
          </section>

          {task.workspace_id !== null && me && <Comments task={task} members={members} meId={me.id} />}

          {task.workspace_id !== null && me && (
            <section className="panel-section" aria-label="History">
              <h3>
                <History size={14} /> History
                <button type="button" className="ghost suggest-btn" onClick={() => setShowHistory((v) => !v)}>{showHistory ? "Hide" : "Show"}</button>
              </h3>
              {showHistory && history.isLoading && <p className="muted small">Loading…</p>}
              {showHistory && (
                <ul className="feed compact">
                  {history.data?.map((a) => (
                    <li key={a.id}>
                      <Avatar id={a.user_id} name={nameOf(a.user_id)} size={20} />
                      <span><strong>{a.user_id === me.id ? "You" : nameOf(a.user_id)}</strong> {describeActivity(a, nameOf)}</span>
                      <span className="muted small" title={new Date(a.created_at).toLocaleString()}>{timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {error && <p className="alert" role="alert" style={{ marginTop: 16 }}>{error}</p>}
        </div>

        <div className="drawer-foot">
          {task.can_delete ? (
            <button className="ghost danger-text" onClick={() => confirm("Delete this task and its subtasks?") && remove.mutate()}>
              <Trash2 size={15} /> Delete
            </button>
          ) : (
            <span />
          )}
          {readOnly ? (
            <button className="secondary" onClick={onClose}>Close</button>
          ) : (
            <button onClick={() => save.mutate(draft)} disabled={!draft.title.trim() || save.isPending}>
              Save
            </button>
          )}
        </div>
      </aside>
      {editMeeting !== null && (
        <div onClick={(e) => e.stopPropagation()}>
          <MeetingDrawer meetingId={editMeeting} onClose={() => setEditMeeting(null)} onOpenTask={(t) => (setEditMeeting(null), onOpen(t))} />
        </div>
      )}
    </div>
  );
}
