import { enqueue, overlayQueue } from "./lib/offline";

export interface Recurrence {
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays?: number[];
}

export type Role = "owner" | "admin" | "member" | "viewer";

export interface Task {
  id: number;
  /** The person who created it. */
  user_id: number;
  assignee_id: number | null;
  /** null for private tasks. */
  workspace_id: number | null;
  /** What the signed-in person may do with it. */
  access: "read" | "write" | "admin";
  can_delete: boolean;
  comment_count: number;
  meeting_count: number;
  project_id: number | null;
  parent_id: number | null;
  title: string;
  notes: string;
  priority: number;
  status: "todo" | "doing" | "done";
  /** The custom status (see Status), or null for the built-in one of this category. */
  status_id: number | null;
  /** When work is planned to begin (ISO); with due_at it gives the task a span on the timeline. */
  start_at: string | null;
  milestone_id: number | null;
  /** A deal's worth (sales pipelines). */
  value: number | null;
  /** Support tickets: who asked, where it came from, its number and its service clocks. */
  requester_name: string | null;
  requester_email: string | null;
  source: "internal" | "form" | "email";
  ticket_no: number | null;
  first_response_at: string | null;
  sla: Sla | null;
  due_at: string | null;
  remind_at: string | null;
  recurrence: Recurrence | null;
  completed_at: string | null;
  created_at: string; // SQLite UTC "YYYY-MM-DD HH:MM:SS"
  tags: string[];
  position: number;
  estimate_min: number | null;
  blocked_by: number[];
  blocked: boolean;
  subtasks_total: number;
  subtasks_done: number;
  checklist_total: number;
  checklist_done: number;
  tracked_min: number;
  timer_running: boolean;
}

export interface Meeting {
  id: number;
  /** null for a private meeting. */
  workspace_id: number | null;
  created_by: number;
  title: string;
  notes: string;
  starts_at: string;
  ends_at: string;
  location: string;
  url: string;
  /** "local" for meetings made here; "google" is reserved for meetings that come from a linked calendar. */
  source: "local" | "google";
  external_url: string | null;
  created_at: string;
  task_ids: number[];
  access: "read" | "write" | "admin";
  can_delete: boolean;
}

export interface NewMeeting {
  title: string;
  starts_at: string;
  ends_at?: string;
  location?: string;
  url?: string;
  notes?: string;
  workspace_id?: number | null;
  task_ids?: number[];
}

export interface ChecklistItem {
  id: number;
  text: string;
  done: boolean;
}

export type FilterQuery = Record<string, string | number>;

export interface SavedFilter {
  id: number;
  name: string;
  query: FilterQuery;
}

export interface Stats {
  completed_by_day: { day: string; count: number }[];
  open_total: number;
  overdue: number;
  completed_week: number;
  time_by_project: { project_id: number | null; name: string; minutes: number }[];
}

export interface RunningTimer {
  task_id: number;
  started_at: string;
  title: string;
}

export type Category = "todo" | "doing" | "done";

export interface Status {
  id: number;
  /** Set for a workspace-wide status; null when the status belongs to one project. */
  workspace_id: number | null;
  project_id: number | null;
  name: string;
  category: Category;
  color: string;
  position: number;
  /** Chance (0-100) a deal in this status is won; sales pipelines. */
  probability: number | null;
}

export type SlaState = "met" | "late" | "pending" | "at_risk" | "breached";
export interface SlaClock {
  due: string;
  state: SlaState;
}
export interface Sla {
  response: SlaClock | null;
  resolution: SlaClock | null;
}

export type ProjectType = "delivery" | "pipeline" | "initiative" | "support";
export type Stage = "planning" | "active" | "on_hold" | "completed" | "archived";
export type Health = "on_track" | "at_risk" | "off_track";

export interface Project {
  id: number;
  name: string;
  color: string;
  /** null for private projects. */
  workspace_id: number | null;
  type: ProjectType;
  description: string;
  stage: Stage;
  lead_id: number | null;
  /** YYYY-MM-DD */
  start_date: string | null;
  target_date: string | null;
  currency: string;
  first_response_hours: number | null;
  resolution_hours: number | null;
}

export interface Milestone {
  id: number;
  project_id: number;
  name: string;
  due_date: string | null;
  completed_at: string | null;
  position: number;
}

export interface Signal {
  code: string;
  text: string;
}

export interface PortfolioRow extends Project {
  tasks_total: number;
  tasks_done: number;
  tasks_doing: number;
  tasks_overdue: number;
  /** Done work as a share of all work, weighted by estimate. 0 to 100. */
  progress_pct: number;
  milestones_total: number;
  milestones_done: number;
  next_milestone: { name: string; due_date: string | null } | null;
  /** The team's own latest rating. */
  health: Health | null;
  /** What the numbers suggest (active projects only). */
  suggested_health: Health | null;
  signals: Signal[];
  last_update_at: string | null;
}

export interface MilestoneProgress extends Milestone {
  tasks_total: number;
  tasks_done: number;
  tasks_late: number;
  overdue: boolean;
}

export interface AttentionTask {
  id: number;
  title: string;
  project_id: number | null;
  project_name: string | null;
  workspace_id: number | null;
  due_at: string | null;
  assignee_id: number | null;
  status: string;
}

export interface AttentionList {
  total: number;
  items: AttentionTask[];
}

export interface AttentionProject {
  id: number;
  name: string;
  color: string;
  workspace_id: number | null;
  stage: Stage;
  target_date: string | null;
  progress_pct: number;
  health: Health | null;
  suggested_health: Health | null;
  signals: Signal[];
}

export interface Attention {
  is_manager: boolean;
  projects: AttentionProject[];
  overdue: AttentionList;
  blocked: AttentionList;
  unassigned: AttentionList;
  workload: { workspace_id: number; assignee_id: number | null; name: string | null; open: number; overdue: number }[];
}

export interface ProjectUpdate {
  id: number;
  user_id: number;
  author: string;
  kind: "update" | "stage";
  stage: Stage | null;
  health: Health | null;
  body: string;
  created_at: string;
}

export interface ProjectOverview {
  project: Project & { lead_name: string | null };
  access: { can_write: boolean; can_manage: boolean };
  transitions: Stage[];
  progress: Omit<PortfolioRow, keyof Project> & { tasks_blocked: number };
  by_status: { id: number | null; name: string; color: string; category: Category; count: number }[];
  workload: { assignee_id: number | null; open: number }[];
  time: { tracked_min: number; estimate_min: number };
  milestones: MilestoneProgress[];
  updates: ProjectUpdate[];
  pipeline: PipelineForecast | null;
  support: SupportStats | null;
  /** The public form link and email address; only for people who manage a support project. */
  intake: { enabled: boolean; token: string | null } | null;
}

export interface PipelineForecast {
  currency: string;
  open_count: number;
  open_value: number;
  weighted_value: number;
  won_count: number;
  won_value: number;
  lost_count: number;
  lost_value: number;
  win_rate: number | null;
  avg_won_value: number | null;
  by_stage: { id: number | null; name: string; color: string; category: Category; probability: number | null; count: number; value: number; weighted: number }[];
  by_month: { month: string; count: number; value: number; weighted: number }[];
  no_close_date: { count: number; value: number };
}

export interface SupportStats {
  open: number;
  unanswered: number;
  response_breached: number;
  resolution_breached: number;
  at_risk: number;
  avg_first_response_min: number | null;
  avg_resolution_min: number | null;
  created_7d: number;
  resolved_7d: number;
  by_priority: { priority: number; open: number }[];
  targets: { first_response_hours: number | null; resolution_hours: number | null };
}

export type StatusScope = { project_id: number } | { workspace_id: number };

export interface Person {
  id: number;
  name: string;
  email: string;
}

export interface Workspace {
  id: number;
  name: string;
  role: Role;
  member_count: number;
}

export interface Member extends Person {
  role: Role;
  joined_at: string;
}

export interface WorkspaceInvite {
  id: number;
  email: string;
  role: Exclude<Role, "owner">;
  created_at: string;
  invited_by: string;
}

export interface WorkspaceDetail {
  id: number;
  name: string;
  role: Role;
  members: Member[];
  invites: WorkspaceInvite[];
}

export interface MyInvite {
  id: number;
  role: Exclude<Role, "owner">;
  created_at: string;
  workspace_id: number;
  workspace_name: string;
  invited_by: string;
}

export interface Comment {
  id: number;
  user_id: number;
  body: string;
  created_at: string;
  edited_at: string | null;
  /** Set when the words are a customer's (emailed in), not a teammate's. */
  requester: string | null;
  mentions: { id: number; name: string }[];
}

export interface ActivityItem {
  id: number;
  kind: string;
  user_id: number;
  task_id: number | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface Alert {
  id: number;
  kind: "assigned" | "mentioned" | "commented" | "invite_accepted" | "removed" | "ticket";
  actor_id: number | null;
  task_id: number | null;
  workspace_id: number | null;
  title: string;
  created_at: string;
  read: boolean;
}

export interface AlertsResponse {
  unread: number;
  invites: number;
  items: Alert[];
}

export interface Tag {
  id: number;
  name: string;
}

export interface Notification {
  id: number;
  title: string;
  due_at: string | null;
  remind_at: string;
}

export interface DayPlan {
  summary: string;
  order: { id: number; title: string; reason: string }[];
}

export interface GoogleSettings {
  calendar: boolean;
  gmail: boolean;
  gmailLabel: string;
}

export interface IntegrationStatus {
  google: { configured: boolean; connected: boolean; account: string | null; settings: GoogleSettings; last_sync: string | null };
}

export interface SyncSummary {
  calendar: { created: number; updated: number; pulled: number; removed: number } | null;
  gmail: { imported: number } | null;
  last_sync: string;
}

export interface ImportSummary {
  tasks: number;
  projects: number;
  filters: number;
  meetings?: number;
  warnings: string[];
}

export type ImportFormat = "json" | "csv" | "todoist" | "trello";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    // No connection. Reads fall back to the service worker's cache before reaching here; writes are queued when supported.
    if (method !== "GET") {
      const queued = enqueue(method, url, body);
      if (queued !== null) return queued as T;
    }
    throw new ApiError(0, method === "GET" ? "You're offline and this isn't saved on your device yet" : "You're offline — this change needs a connection");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export const api = {
  me: () => request<{ id: number; email: string; name: string }>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ email: string }>("POST", "/auth/login", { email, password }),
  register: (email: string, password: string, name?: string) =>
    request<{ email: string }>("POST", "/auth/register", { email, password, ...(name ? { name } : {}) }),
  updateProfile: (name: string) => request<{ id: number; email: string; name: string }>("PATCH", "/auth/me", { name }),
  logout: () => request<void>("POST", "/auth/logout"),

  tasks: (query: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    return request<Task[]>("GET", `/tasks?${qs}`).then(overlayQueue);
  },
  createTask: (t: Partial<Omit<Task, "id">>) => request<Task>("POST", "/tasks", t),
  updateTask: (id: number, t: Partial<Omit<Task, "id">>) => request<Task>("PATCH", `/tasks/${id}`, t),
  deleteTask: (id: number) => request<void>("DELETE", `/tasks/${id}`),
  completeTask: (id: number, statusId?: number) =>
    request<{ completed: Task; next: Task | null }>("POST", `/tasks/${id}/complete`, statusId === undefined ? undefined : { status_id: statusId }),

  projects: () => request<Project[]>("GET", "/projects"),
  createProject: (name: string, workspaceId?: number, extra: Partial<Pick<Project, "type" | "color" | "description" | "lead_id" | "start_date" | "target_date">> = {}) =>
    request<Project>("POST", "/projects", { name, ...(workspaceId ? { workspace_id: workspaceId } : {}), ...extra }),
  setIntake: (id: number, enabled: boolean, rotate = false) => request<{ enabled: boolean; token: string | null }>("POST", `/projects/${id}/intake`, { enabled, rotate }),
  respond: (taskId: number) => request<Task>("POST", `/tasks/${taskId}/respond`),
  publicDesk: (token: string) => request<{ name: string }>("GET", `/public/support/${token}`),
  publicTicket: (token: string, t: { name: string; email: string; subject: string; message: string; website?: string }) =>
    request<{ ticket_no: number | null }>("POST", `/public/support/${token}`, t),
  attention: () => request<Attention>("GET", "/attention"),
  renameProject: (id: number, name: string) => request<Project>("PATCH", `/projects/${id}`, { name }),
  updateProject: (id: number, p: Partial<Pick<Project, "name" | "color" | "type" | "description" | "lead_id" | "start_date" | "target_date" | "currency" | "first_response_hours" | "resolution_hours">>) =>
    request<Project>("PATCH", `/projects/${id}`, p),
  setStage: (id: number, stage: Stage, note?: string, force?: boolean) => request<Project>("POST", `/projects/${id}/stage`, { stage, note, force }),
  portfolio: () => request<PortfolioRow[]>("GET", "/portfolio"),
  overview: (id: number) => request<ProjectOverview>("GET", `/projects/${id}/overview`),
  postUpdate: (id: number, health: Health, body: string) => request<ProjectUpdate>("POST", `/projects/${id}/updates`, { health, body }),
  deleteUpdate: (id: number, updateId: number) => request<void>("DELETE", `/projects/${id}/updates/${updateId}`),
  addMilestone: (id: number, name: string, due_date: string | null) => request<Milestone>("POST", `/projects/${id}/milestones`, { name, due_date }),
  updateMilestone: (id: number, m: { name?: string; due_date?: string | null; done?: boolean }) => request<Milestone>("PATCH", `/milestones/${id}`, m),
  deleteMilestone: (id: number) => request<void>("DELETE", `/milestones/${id}`),

  statuses: () => request<Status[]>("GET", "/statuses"),
  seedStatuses: (scope: StatusScope) => request<Status[]>("POST", "/statuses/defaults", scope),
  addStatus: (scope: StatusScope, s: { name: string; category: Category; color?: string }) => request<Status>("POST", "/statuses", { ...scope, ...s }),
  updateStatus: (id: number, s: Partial<Pick<Status, "name" | "color" | "position" | "probability">>) => request<Status>("PATCH", `/statuses/${id}`, s),
  deleteStatus: (id: number) => request<void>("DELETE", `/statuses/${id}`),
  resetStatuses: (scope: StatusScope) =>
    request<void>("DELETE", `/statuses?${"project_id" in scope ? `project_id=${scope.project_id}` : `workspace_id=${scope.workspace_id}`}`),
  deleteProject: (id: number) => request<void>("DELETE", `/projects/${id}`),
  tags: () => request<Tag[]>("GET", "/tags"),

  addDep: (id: number, blockedBy: number) => request<Task>("POST", `/tasks/${id}/deps`, { blocked_by_id: blockedBy }),
  removeDep: (id: number, blockedBy: number) => request<Task>("DELETE", `/tasks/${id}/deps/${blockedBy}`),

  checklist: (id: number) => request<ChecklistItem[]>("GET", `/tasks/${id}/checklist`),
  addCheckItem: (id: number, text: string) => request<ChecklistItem>("POST", `/tasks/${id}/checklist`, { text }),
  updateCheckItem: (itemId: number, p: Partial<Pick<ChecklistItem, "text" | "done">>) =>
    request<ChecklistItem>("PATCH", `/checklist/${itemId}`, p),
  deleteCheckItem: (itemId: number) => request<void>("DELETE", `/checklist/${itemId}`),

  filters: () => request<SavedFilter[]>("GET", "/filters"),
  saveFilter: (name: string, query: FilterQuery) => request<SavedFilter>("POST", "/filters", { name, query }),
  deleteFilter: (id: number) => request<void>("DELETE", `/filters/${id}`),

  timer: () => request<RunningTimer | null>("GET", "/timer"),
  startTimer: (id: number) => request<Task>("POST", `/tasks/${id}/timer/start`),
  stopTimer: () => request<Task | null>("POST", "/timer/stop"),

  stats: () => request<Stats>("GET", `/stats?offset=${-new Date().getTimezoneOffset()}`),

  meetings: (query: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return request<Meeting[]>("GET", `/meetings?${qs}`);
  },
  taskMeetings: (taskId: number) => request<Meeting[]>("GET", `/tasks/${taskId}/meetings`),
  createMeeting: (m: NewMeeting) => request<Meeting>("POST", "/meetings", m),
  updateMeeting: (id: number, m: Partial<Pick<Meeting, "title" | "starts_at" | "ends_at" | "location" | "url" | "notes">>) => request<Meeting>("PATCH", `/meetings/${id}`, m),
  deleteMeeting: (id: number) => request<void>("DELETE", `/meetings/${id}`),
  linkMeeting: (id: number, taskId: number) => request<Meeting>("POST", `/meetings/${id}/tasks`, { task_id: taskId }),
  unlinkMeeting: (id: number, taskId: number) => request<Meeting>("DELETE", `/meetings/${id}/tasks/${taskId}`),

  people: () => request<Person[]>("GET", "/people"),

  workspaces: () => request<Workspace[]>("GET", "/workspaces"),
  workspace: (id: number) => request<WorkspaceDetail>("GET", `/workspaces/${id}`),
  createWorkspace: (name: string) => request<Workspace>("POST", "/workspaces", { name }),
  renameWorkspace: (id: number, name: string) => request<{ id: number; name: string }>("PATCH", `/workspaces/${id}`, { name }),
  deleteWorkspace: (id: number) => request<void>("DELETE", `/workspaces/${id}`),
  invite: (id: number, email: string, role: string) => request<{ email: string; role: string }>("POST", `/workspaces/${id}/invites`, { email, role }),
  revokeInvite: (id: number, inviteId: number) => request<void>("DELETE", `/workspaces/${id}/invites/${inviteId}`),
  setRole: (id: number, userId: number, role: Role) => request<{ id: number; role: Role }>("PATCH", `/workspaces/${id}/members/${userId}`, { role }),
  removeMember: (id: number, userId: number) => request<void>("DELETE", `/workspaces/${id}/members/${userId}`),
  workspaceActivity: (id: number, before?: number) =>
    request<{ items: ActivityItem[]; next: number | null }>("GET", `/workspaces/${id}/activity?limit=20${before ? `&before=${before}` : ""}`),

  myInvites: () => request<MyInvite[]>("GET", "/invites"),
  acceptInvite: (id: number) => request<{ workspace_id: number; role: Role }>("POST", `/invites/${id}/accept`),
  declineInvite: (id: number) => request<void>("POST", `/invites/${id}/decline`),

  comments: (taskId: number) => request<Comment[]>("GET", `/tasks/${taskId}/comments`),
  addComment: (taskId: number, body: string, mentions: number[]) => request<Comment>("POST", `/tasks/${taskId}/comments`, { body, mentions }),
  editComment: (id: number, body: string, mentions: number[]) => request<Comment>("PATCH", `/comments/${id}`, { body, mentions }),
  deleteComment: (id: number) => request<void>("DELETE", `/comments/${id}`),
  taskActivity: (taskId: number) => request<ActivityItem[]>("GET", `/tasks/${taskId}/activity`),

  alerts: () => request<AlertsResponse>("GET", "/alerts"),
  markAlertsRead: (ids?: number[]) => request<void>("POST", "/alerts/read", ids ? { ids } : {}),

  aiStatus: () => request<{ enabled: boolean }>("GET", "/ai/status"),
  suggestSubtasks: (id: number) => request<{ subtasks: string[] }>("POST", `/tasks/${id}/ai/breakdown`),
  planDay: () => request<DayPlan>("POST", `/ai/plan-day?tz=${-new Date().getTimezoneOffset()}`),

  integrations: () => request<IntegrationStatus>("GET", "/integrations"),
  googleConnectUrl: () => request<{ url: string }>("GET", "/integrations/google/connect"),
  googleSettings: (p: Partial<GoogleSettings>) => request<GoogleSettings>("PATCH", "/integrations/google/settings", p),
  googleSync: () => request<SyncSummary>("POST", `/integrations/google/sync?tz=${-new Date().getTimezoneOffset()}`),
  googleDisconnect: () => request<void>("DELETE", "/integrations/google"),

  /** Uploads a file's text. JSON-based formats are parsed first so the server receives application/json. */
  async importFile(format: ImportFormat, file: File, project?: string): Promise<ImportSummary> {
    const text = await file.text();
    const asJson = format === "json" || format === "trello";
    let body: BodyInit = text;
    if (asJson) {
      try {
        JSON.parse(text);
      } catch {
        throw new ApiError(400, "That file isn't valid JSON");
      }
    }
    const qs = new URLSearchParams({ format, tz: String(-new Date().getTimezoneOffset()) });
    if (project) qs.set("project", project);
    const res = await fetch(`/api/import?${qs}`, { method: "POST", headers: { "Content-Type": asJson ? "application/json" : "text/csv" }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? "Import failed");
    return data as ImportSummary;
  },

  notifications: () => request<Notification[]>("GET", "/notifications"),
  ackNotification: (id: number) => request<void>("POST", `/notifications/${id}/ack`),
};
