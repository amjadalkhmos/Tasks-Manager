import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, CalendarClock, CalendarDays, Flag, Folder, Hash, Inbox, ListTodo, Plus, Repeat, Sparkles, Sun, UserCheck, X } from "lucide-react";
import { api, type FilterQuery, type Task } from "../api";
import { EmptyState, Skeleton } from "../components/EmptyState";
import { TaskRow } from "../components/TaskRow";
import { parseQuickAdd } from "../lib/quickAdd";
import { PRIORITY, applyQuery, describeRecurrence, formatDue, groupTasks, startOfDay } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

export type View = "inbox" | "today" | "upcoming" | "all" | "assigned" | "project" | "tag" | "filter";

const TITLES: Record<View, string> = {
  inbox: "Inbox",
  today: "Today",
  upcoming: "Upcoming",
  all: "All tasks",
  assigned: "Assigned to me",
  project: "Project",
  tag: "Tag",
  filter: "Smart list",
};

function matches(view: View, t: Task, params: { id?: string; name?: string }, me: number): boolean {
  if (view === "filter" || view === "all") return true;
  if (view === "assigned") return t.assignee_id === me;
  if (t.parent_id !== null) return false; // subtasks are shown inside their parent's detail
  const today = startOfDay(new Date()).getTime();
  const due = t.due_at ? startOfDay(new Date(t.due_at)).getTime() : null;
  switch (view) {
    case "inbox":
      return t.project_id === null && t.status !== "done";
    case "today":
      return t.status !== "done" && due !== null && due <= today; // includes overdue
    case "upcoming":
      return t.status !== "done" && due !== null && due > today;
    case "project":
      return t.project_id === Number(params.id);
    case "tag":
      return t.tags.includes((params.name ?? "").toLowerCase());
  }
}

function empty(view: View, filtered: boolean) {
  if (filtered) return { icon: <ListTodo size={20} />, title: "No tasks match", body: "Try loosening a filter or clearing the search." };
  switch (view) {
    case "inbox":
      return { icon: <Inbox size={20} />, title: "Inbox is clear", body: "Tasks without a project land here. Capture one above — dates, #tags and !priority are understood." };
    case "today":
      return { icon: <Sun size={20} />, title: "Nothing due today", body: "Overdue and due-today tasks collect here. Add one with a date, like “call Sam today 5pm”." };
    case "upcoming":
      return { icon: <CalendarClock size={20} />, title: "Nothing scheduled ahead", body: "Tasks with a future due date show up here, grouped by day." };
    case "assigned":
      return { icon: <UserCheck size={20} />, title: "Nothing assigned to you", body: "Tasks teammates assign to you show up here. Inside a workspace project you can assign tasks to yourself too." };
    case "project":
      return { icon: <Folder size={20} />, title: "This project is empty", body: "Add the first task above — it’s filed here automatically." };
    case "tag":
      return { icon: <Hash size={20} />, title: "No tasks with this tag", body: "Add a task above and it gets this tag automatically." };
    case "filter":
      return { icon: <BookmarkPlus size={20} />, title: "No tasks match this smart list", body: "Tasks that fit its filters appear here as soon as they exist." };
    default:
      return { icon: <ListTodo size={20} />, title: "No tasks yet", body: "Add your first task above." };
  }
}

/** `embedded`: shown under a page that already has the heading (a project's page), so this one leaves it out. */
export function TaskList({ view, onOpen, embedded }: { view: View; onOpen: (id: number) => void; embedded?: boolean }) {
  const params = useParams();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const filters = useQuery({ queryKey: ["filters"], queryFn: api.filters });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data?.id ?? 0;
  const actions = useTaskActions();
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [adhoc, setAdhoc] = useState<FilterQuery>({});
  const aiStatus = useQuery({ queryKey: ["ai-status"], queryFn: api.aiStatus, staleTime: 5 * 60_000 });
  const plan = useMutation({ mutationFn: api.planDay });
  const [naming, setNaming] = useState(false);
  const [listName, setListName] = useState("");

  const create = useMutation({
    mutationFn: async (input: string) => {
      const p = parseQuickAdd(input);
      let project_id: number | null = view === "project" ? Number(params.id) : null;
      if (p.project) {
        const known = projects.data?.find((x) => x.name.toLowerCase() === p.project!.toLowerCase());
        project_id = known ? known.id : (await api.createProject(p.project)).id;
      }
      const tags = [...p.tags, ...(view === "tag" && params.name ? [params.name] : [])];
      return api.createTask({
        title: p.title,
        priority: p.priority,
        project_id,
        tags,
        recurrence: p.recurrence,
        due_at: p.due_at ?? (view === "today" ? startOfDay(new Date()).toISOString() : null),
      });
    },
    onSuccess: () => {
      setText("");
      void actions.refresh();
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const saveFilter = useMutation({
    mutationFn: (name: string) => api.saveFilter(name, adhoc),
    onSuccess: () => {
      setNaming(false);
      setListName("");
      void qc.invalidateQueries({ queryKey: ["filters"] });
    },
  });

  const saved = view === "filter" ? filters.data?.find((f) => f.id === Number(params.id)) : undefined;
  const query: FilterQuery = view === "filter" ? (saved?.query ?? {}) : view === "all" ? adhoc : {};
  const isFiltered = Object.keys(query).length > 0;

  const all = tasks.data ?? [];
  const scoped = applyQuery(
    all.filter((t) => matches(view, t, params, me)),
    query,
  );
  const visible = scoped.filter((t) => showDone || t.status !== "done" || query.status === "done");
  const openCount = scoped.filter((t) => t.status !== "done").length;
  const groups = groupTasks(view, visible);

  // A workspace project can be read-only for the signed-in person (viewer role).
  const currentProject = view === "project" ? projects.data?.find((p) => p.id === Number(params.id)) : undefined;
  const workspace = currentProject?.workspace_id ? workspaces.data?.find((w) => w.id === currentProject.workspace_id) : undefined;
  const archived = currentProject?.stage === "archived";
  const viewOnly = workspace?.role === "viewer" || archived;

  const heading =
    view === "project"
      ? (projects.data?.find((p) => p.id === Number(params.id))?.name ?? TITLES[view])
      : view === "tag"
        ? `#${params.name}`
        : view === "filter"
          ? (saved?.name ?? TITLES[view])
          : TITLES[view];

  const setAdhocKey = (key: string, value: string) =>
    setAdhoc((q) => {
      const next = { ...q };
      if (value === "") delete next[key];
      else next[key] = value;
      return next;
    });

  const preview = text.trim() ? parseQuickAdd(text) : null;
  const error = create.error?.message ?? actions.error;
  const e = empty(view, isFiltered);

  return (
    <div>
      <header className="page-header">
        {embedded ? (
          <p className="sub">{openCount} open{viewOnly ? " · view only" : ""}</p>
        ) : (
          <div>
            <h1>{heading}</h1>
            {tasks.data && <p className="sub">{openCount} open{workspace ? ` · ${workspace.name}` : ""}{viewOnly ? " · view only" : ""}</p>}
          </div>
        )}
        <div className="page-actions">
          {view === "today" && aiStatus.data?.enabled && (
            <button type="button" className="secondary" disabled={plan.isPending} onClick={() => plan.mutate()}>
              <Sparkles size={15} /> {plan.isPending ? "Planning…" : "Plan my day"}
            </button>
          )}
          <label className="toggle">
            <input type="checkbox" checked={showDone} onChange={(ev) => setShowDone(ev.target.checked)} /> Show completed
          </label>
        </div>
      </header>

      {plan.error && <p className="alert" role="alert">{plan.error.message}</p>}
      {plan.data && (
        <section className="plan" aria-label="Suggested plan for today">
          <div className="plan-head">
            <h2><Sparkles size={15} /> Your day</h2>
            <button type="button" className="icon sm" aria-label="Dismiss plan" onClick={() => plan.reset()}><X size={14} /></button>
          </div>
          <p>{plan.data.summary}</p>
          {plan.data.order.length > 0 && (
            <ol>
              {plan.data.order.map((o) => (
                <li key={o.id}>
                  <button type="button" className="link" onClick={() => onOpen(o.id)}>{o.title}</button>
                  <span className="muted small"> — {o.reason}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="muted small">Suggested by AI from your open tasks; you decide what to do.</p>
        </section>
      )}

      {view === "all" && (
        <div className="filter-bar">
          <input placeholder="Search…" aria-label="Search" value={String(adhoc.q ?? "")} onChange={(ev) => setAdhocKey("q", ev.target.value)} />
          <select aria-label="Priority" value={String(adhoc.priority ?? "")} onChange={(ev) => setAdhocKey("priority", ev.target.value)}>
            <option value="">Any priority</option>
            {PRIORITY.map((p, i) => (
              <option key={p} value={i}>{p}</option>
            ))}
          </select>
          <select aria-label="Project" value={String(adhoc.project_id ?? "")} onChange={(ev) => setAdhocKey("project_id", ev.target.value)}>
            <option value="">Any project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input placeholder="tag" aria-label="Tag" value={String(adhoc.tag ?? "")} onChange={(ev) => setAdhocKey("tag", ev.target.value)} />
          {naming ? (
            <form
              className="save-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (listName.trim()) saveFilter.mutate(listName.trim());
              }}
            >
              <input autoFocus placeholder="Smart list name" aria-label="Smart list name" value={listName} onChange={(ev) => setListName(ev.target.value)} />
              <button type="submit" disabled={!listName.trim() || saveFilter.isPending}>Save</button>
              <button type="button" className="ghost" onClick={() => setNaming(false)}>Cancel</button>
            </form>
          ) : (
            <button type="button" className="secondary" disabled={!isFiltered} onClick={() => setNaming(true)}>
              <BookmarkPlus size={15} /> Save as smart list
            </button>
          )}
        </div>
      )}

      {viewOnly && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          {archived ? "This project is archived. Restore it from the project's header to add tasks." : `You can read this project but not change it. Ask an admin of ${workspace?.name} for member access.`}
        </p>
      )}

      {view !== "filter" && !viewOnly && (
        <>
          <form
            className="quick-add"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (text.trim()) create.mutate(text.trim());
            }}
          >
            <Plus size={18} aria-hidden="true" />
            <input
              id="quick-add-input"
              aria-label="Add a task"
              autoComplete="off"
              placeholder="Add a task… try “Call Sam tomorrow 3pm !high #work every week”"
              value={text}
              onChange={(ev) => setText(ev.target.value)}
            />
          </form>
          <div className="parse-preview" aria-live="polite">
            {preview && (
              <>
                <span className="muted">Will add “{preview.title}”</span>
                {preview.due_at && <span className="tok"><CalendarDays size={12} />{formatDue(preview.due_at)}</span>}
                {preview.priority > 0 && <span className="tok"><Flag size={12} />{PRIORITY[preview.priority]}</span>}
                {preview.recurrence && <span className="tok"><Repeat size={12} />{describeRecurrence(preview.recurrence)}</span>}
                {preview.tags.map((g) => (
                  <span className="tok" key={g}>#{g}</span>
                ))}
                {preview.project && <span className="tok"><Folder size={12} />{preview.project}</span>}
              </>
            )}
          </div>
        </>
      )}

      {error && <p className="alert" role="alert">{error}</p>}
      {tasks.error && <p className="alert" role="alert">{tasks.error.message}</p>}
      {tasks.isLoading && <Skeleton />}
      {!tasks.isLoading && !tasks.error && groups.length === 0 && (
        <EmptyState icon={e.icon} title={e.title}>{e.body}</EmptyState>
      )}

      {groups.map((g) => (
        <section className="group" key={g.key}>
          {g.label && (
            <h2 className={`group-label${g.danger ? " danger" : ""}`}>
              {g.label} <span className="count">{g.tasks.length}</span>
            </h2>
          )}
          <ul className="tasks">
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={onOpen} onToggle={actions.toggle} nested={t.parent_id !== null} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
