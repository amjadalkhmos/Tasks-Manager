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
  project_id: number | null;
  parent_id: number | null;
  title: string;
  notes: string;
  priority: number;
  status: "todo" | "doing" | "done";
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

export interface Project {
  id: number;
  name: string;
  color: string;
  /** null for private projects. */
  workspace_id: number | null;
}

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
  kind: "assigned" | "mentioned" | "commented" | "invite_accepted" | "removed";
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
  completeTask: (id: number) => request<{ completed: Task; next: Task | null }>("POST", `/tasks/${id}/complete`),

  projects: () => request<Project[]>("GET", "/projects"),
  createProject: (name: string, workspaceId?: number) =>
    request<Project>("POST", "/projects", { name, ...(workspaceId ? { workspace_id: workspaceId } : {}) }),
  renameProject: (id: number, name: string) => request<Project>("PATCH", `/projects/${id}`, { name }),
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
