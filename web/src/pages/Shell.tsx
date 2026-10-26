import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, BookmarkCheck, CalendarClock, CalendarDays, ChartNoAxesColumn, Check, Hash, Inbox, KanbanSquare, ListTodo, LogOut, Menu, Plus, RefreshCw, Search, Settings, Sun, Timer, UserCheck, Users, WifiOff, X,
} from "lucide-react";
import { api } from "../api";
import { clearOfflineData, flushQueue, usePendingCount } from "../lib/offline";
import { formatMinutes, startOfDay } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";
import { BoardPage } from "./BoardPage";
import { CalendarPage } from "./CalendarPage";
import { CommandPalette } from "./CommandPalette";
import { DashboardPage } from "./DashboardPage";
import { NotificationsPage } from "./NotificationsPage";
import { SettingsPage } from "./SettingsPage";
import { WorkspacePage } from "./WorkspacePage";
import { TaskDetail } from "./TaskDetail";
import { TaskList } from "./TaskList";

function useReminders() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: api.notifications, refetchInterval: 30_000 });
  const ack = useMutation({
    mutationFn: api.ackNotification,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }, []);

  // Fire a browser notification for each newly arrived reminder, keeping the in-app banner until dismissed.
  const [shown] = useState(() => new Set<number>());
  useEffect(() => {
    for (const n of data ?? []) {
      if (shown.has(n.id)) continue;
      shown.add(n.id);
      if ("Notification" in window && Notification.permission === "granted") new Notification("Reminder", { body: n.title });
    }
  }, [data, shown]);

  return { reminders: data ?? [], dismiss: ack.mutate };
}

/** Elapsed time of the running timer, re-rendered every second. */
function TimerBar({ onOpen }: { onOpen: (id: number) => void }) {
  const actions = useTaskActions();
  const timer = useQuery({ queryKey: ["timer"], queryFn: api.timer, refetchInterval: 60_000 });
  const stop = useMutation({ mutationFn: api.stopTimer, onSuccess: actions.refresh });
  const [, tick] = useState(0);
  const running = timer.data;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!running) return null;
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(running.started_at)) / 1000));
  const clock = `${formatMinutes(Math.floor(secs / 60))} ${String(secs % 60).padStart(2, "0")}s`;
  return (
    <div className="banner timer" role="status">
      <span>
        <Timer size={16} />
        <button className="link" onClick={() => onOpen(running.task_id)}>{running.title}</button>
        <span>{clock}</span>
      </span>
      <button className="link" onClick={() => stop.mutate()}>Stop</button>
    </div>
  );
}

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine);

/** Replays changes made offline whenever a connection is available, then refreshes everything from the server. */
function useOfflineSync(userId: number) {
  const qc = useQueryClient();
  const online = useOnline();
  const pending = usePendingCount();
  const [problem, setProblem] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const r = await flushQueue();
    if (r.sent || r.failed) await qc.invalidateQueries();
    if (r.failed) setProblem(`${r.failed} change${r.failed === 1 ? "" : "s"} made offline couldn't be applied (the task may have been changed or deleted elsewhere).`);
  }, [qc]);

  useEffect(() => {
    if (!online || pending === 0) return;
    void sync();
    const retry = setInterval(() => void sync(), 15_000); // covers "online" but the server was unreachable
    return () => clearInterval(retry);
  }, [online, pending, sync]);

  return { online, pending, problem, dismissProblem: () => setProblem(null) };
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

const ICON = 16;

export function Shell({ user }: { user: { id: number; email: string } }) {
  const email = user.email;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.tags });
  const filters = useQuery({ queryKey: ["filters"], queryFn: api.filters });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  // Mentions, assignments and invitations: checked every 30 seconds and whenever the window regains focus.
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.alerts, refetchInterval: 30_000 });
  const { reminders, dismiss } = useReminders();
  const offline = useOfflineSync(user.id);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("");

  const addWorkspace = useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    onSuccess: (ws) => {
      setNewWorkspace("");
      void qc.invalidateQueries({ queryKey: ["workspaces"] });
      void qc.invalidateQueries({ queryKey: ["people"] });
      navigate(`/workspace/${ws.id}`);
    },
  });
  const addProject = useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: () => {
      setNewProject("");
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const delFilter = useMutation({
    mutationFn: api.deleteFilter,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["filters"] }),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      await clearOfflineData(); // cached responses and queued changes belong to this person only
      qc.clear();
      // A full navigation, not a cache invalidation: after clear() the app's "who am I" observer is attached to a
      // removed query and would never refetch, leaving the signed-out UI on screen.
      window.location.assign("/login");
    },
  });
  const signOut = () => {
    if (offline.pending > 0 && !confirm(`${offline.pending} change${offline.pending === 1 ? " hasn't" : "s haven't"} synced yet and will be lost if you sign out. Sign out anyway?`)) return;
    logout.mutate();
  };

  // Close the mobile nav after navigating.
  useEffect(() => setNavOpen(false), [pathname]);

  // Global shortcuts: Ctrl/Cmd+K opens the palette; "n" jumps to quick-add (on list views) outside text fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape" && !isTyping(e.target)) {
        setPaletteOpen(false);
      } else if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target) && !paletteOpen) {
        e.preventDefault();
        const field = document.getElementById("quick-add-input");
        if (field) field.focus();
        else setPaletteOpen(true); // no quick-add on this page (board, calendar…): the palette can create tasks
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen]);

  const open = (id: number) => setOpenTask(id);

  const top = (tasks.data ?? []).filter((t) => t.parent_id === null && t.status !== "done");
  const todayStart = startOfDay(new Date()).getTime();
  const inboxCount = top.filter((t) => t.project_id === null).length;
  const dueToday = top.filter((t) => t.due_at && startOfDay(new Date(t.due_at)).getTime() <= todayStart);
  const hasOverdue = dueToday.some((t) => startOfDay(new Date(t.due_at!)).getTime() < todayStart);
  const countOf = (n: number) => (n > 0 ? n : null);
  const assignedCount = top.filter((t) => t.assignee_id === user.id).length;
  const unseen = (alerts.data?.unread ?? 0) + (alerts.data?.invites ?? 0);
  const personalProjects = (projects.data ?? []).filter((p) => p.workspace_id === null);

  const wide = /^\/(board|calendar)/.test(pathname);

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon" aria-label="Open menu" onClick={() => setNavOpen(true)}><Menu size={20} /></button>
        <div className="brand"><span className="brand-mark"><Check size={14} strokeWidth={3} /></span>Tasks</div>
        <button className="icon" aria-label="Search and add" onClick={() => setPaletteOpen(true)}><Search size={18} /></button>
      </header>
      <div className={`scrim${navOpen ? " open" : ""}`} onClick={() => setNavOpen(false)} />

      <aside className={`sidebar${navOpen ? " open" : ""}`} aria-label="Navigation">
        <div className="brand"><span className="brand-mark"><Check size={14} strokeWidth={3} /></span>Tasks</div>
        <button type="button" className="search-btn" onClick={() => setPaletteOpen(true)}>
          <Search size={ICON} /> Search or add <kbd>Ctrl K</kbd>
        </button>

        <nav className="nav-group">
          <NavLink to="/" end><Inbox size={ICON} /><span className="label">Inbox</span>{countOf(inboxCount) && <span className="nav-count">{inboxCount}</span>}</NavLink>
          <NavLink to="/today"><Sun size={ICON} /><span className="label">Today</span>{countOf(dueToday.length) && <span className={`nav-count${hasOverdue ? " overdue-count" : ""}`}>{dueToday.length}</span>}</NavLink>
          <NavLink to="/upcoming"><CalendarClock size={ICON} /><span className="label">Upcoming</span></NavLink>
          <NavLink to="/all"><ListTodo size={ICON} /><span className="label">All tasks</span></NavLink>
          <NavLink to="/assigned"><UserCheck size={ICON} /><span className="label">Assigned to me</span>{countOf(assignedCount) && <span className="nav-count">{assignedCount}</span>}</NavLink>
        </nav>
        <nav className="nav-group" style={{ marginTop: 10 }}>
          <NavLink to="/board"><KanbanSquare size={ICON} /><span className="label">Board</span></NavLink>
          <NavLink to="/calendar"><CalendarDays size={ICON} /><span className="label">Calendar</span></NavLink>
          <NavLink to="/dashboard"><ChartNoAxesColumn size={ICON} /><span className="label">Dashboard</span></NavLink>
          <NavLink to="/notifications">
            <Bell size={ICON} /><span className="label">Notifications</span>
            {unseen > 0 && <span className="nav-badge" aria-label={`${unseen} new`}>{unseen > 99 ? "99+" : unseen}</span>}
          </NavLink>
          <NavLink to="/settings"><Settings size={ICON} /><span className="label">Settings</span></NavLink>
        </nav>

        <div className="nav-title">Projects</div>
        <nav className="nav-group">
          {personalProjects.map((p) => (
            <NavLink key={p.id} to={`/project/${p.id}`}>
              <span className="dot" style={{ background: p.color }} /><span className="label">{p.name}</span>
            </NavLink>
          ))}
        </nav>
        <form
          className="add-project"
          onSubmit={(e) => {
            e.preventDefault();
            if (newProject.trim()) addProject.mutate(newProject.trim());
          }}
        >
          <Plus size={14} aria-hidden="true" />
          <input aria-label="New project" placeholder="New project" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
        </form>
        {addProject.error && <p className="nav-error" role="alert">{addProject.error.message}</p>}

        <div className="nav-title">Workspaces</div>
        {workspaces.data?.map((w) => (
          <nav className="nav-group ws-group" key={w.id} aria-label={w.name}>
            <NavLink to={`/workspace/${w.id}`} className="ws-link">
              <Users size={ICON} /><span className="label">{w.name}</span>
            </NavLink>
            {(projects.data ?? []).filter((p) => p.workspace_id === w.id).map((p) => (
              <NavLink key={p.id} to={`/project/${p.id}`} className="ws-project">
                <span className="dot" style={{ background: p.color }} /><span className="label">{p.name}</span>
              </NavLink>
            ))}
          </nav>
        ))}
        <form
          className="add-project"
          onSubmit={(e) => {
            e.preventDefault();
            if (newWorkspace.trim()) addWorkspace.mutate(newWorkspace.trim());
          }}
        >
          <Plus size={14} aria-hidden="true" />
          <input aria-label="New workspace" placeholder="New workspace" value={newWorkspace} onChange={(e) => setNewWorkspace(e.target.value)} />
        </form>
        {addWorkspace.error && <p className="nav-error" role="alert">{addWorkspace.error.message}</p>}

        {!!filters.data?.length && <div className="nav-title">Smart lists</div>}
        <nav className="nav-group">
          {filters.data?.map((f) => (
            <div className="nav-row" key={f.id}>
              <NavLink to={`/filter/${f.id}`}><BookmarkCheck size={ICON} /><span className="label">{f.name}</span></NavLink>
              <button
                type="button"
                className="icon sm"
                aria-label={`Delete smart list ${f.name}`}
                onClick={() => {
                  if (confirm(`Delete smart list "${f.name}"?`)) {
                    delFilter.mutate(f.id);
                    navigate("/all");
                  }
                }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </nav>

        {!!tags.data?.length && <div className="nav-title">Tags</div>}
        <nav className="nav-group">
          {tags.data?.map((t) => (
            <NavLink key={t.id} to={`/tag/${encodeURIComponent(t.name)}`}><Hash size={ICON} /><span className="label">{t.name}</span></NavLink>
          ))}
        </nav>

        <div className="user">
          <span className="avatar" aria-hidden="true">{email[0]}</span>
          <span className="email" title={email}>{email}</span>
          <button className="icon" aria-label="Sign out" title="Sign out" onClick={signOut}><LogOut size={16} /></button>
        </div>
      </aside>

      <main className={wide ? "wide" : undefined}>
        <div className="page">
          <div className="banners">
            {!offline.online && (
              <div className="banner offline" role="status">
                <span>
                  <WifiOff size={16} />
                  You're offline — changes are kept on this device{offline.pending > 0 ? ` (${offline.pending} waiting to sync)` : ""} and sync when you reconnect.
                </span>
              </div>
            )}
            {offline.online && offline.pending > 0 && (
              <div className="banner offline" role="status">
                <span><RefreshCw size={16} />Syncing {offline.pending} change{offline.pending === 1 ? "" : "s"}…</span>
              </div>
            )}
            {offline.problem && (
              <div className="banner" role="alert">
                <span>{offline.problem}</span>
                <button className="link" onClick={offline.dismissProblem}>Dismiss</button>
              </div>
            )}
            <TimerBar onOpen={open} />
            {reminders.map((r) => (
              <div className="banner" key={r.id} role="alert">
                <span><Bell size={16} />{r.title}</span>
                <button className="link" onClick={() => dismiss(r.id)}>Dismiss</button>
              </div>
            ))}
          </div>
          <Routes>
            <Route path="/" element={<TaskList view="inbox" onOpen={open} />} />
            <Route path="/today" element={<TaskList view="today" onOpen={open} />} />
            <Route path="/upcoming" element={<TaskList view="upcoming" onOpen={open} />} />
            <Route path="/all" element={<TaskList view="all" onOpen={open} />} />
            <Route path="/assigned" element={<TaskList view="assigned" onOpen={open} />} />
            <Route path="/project/:id" element={<TaskList view="project" onOpen={open} />} />
            <Route path="/tag/:name" element={<TaskList view="tag" onOpen={open} />} />
            <Route path="/filter/:id" element={<TaskList view="filter" onOpen={open} />} />
            <Route path="/board" element={<BoardPage onOpen={open} />} />
            <Route path="/calendar" element={<CalendarPage onOpen={open} />} />
            <Route path="/dashboard" element={<DashboardPage onOpen={open} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/notifications" element={<NotificationsPage onOpenTask={open} />} />
            <Route path="/workspace/:id" element={<WorkspacePage onOpenTask={open} />} />
          </Routes>
        </div>
      </main>

      {openTask !== null && <TaskDetail key={openTask} id={openTask} onClose={() => setOpenTask(null)} onOpen={open} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onOpenTask={open} />}
    </div>
  );
}
