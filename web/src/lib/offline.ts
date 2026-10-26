import { useSyncExternalStore } from "react";
import type { Task } from "../api";

/**
 * Offline write queue. When a request fails because there is no connection, the supported task writes
 * (create, edit, complete, delete) are stored here, shown immediately by overlaying them on the task list,
 * and replayed in order once the connection returns.
 *
 * Each operation is tagged with the signed-in user so one person's queued changes are never sent as another's.
 */

export interface QueuedOp {
  id: string;
  user: number;
  method: "POST" | "PATCH" | "DELETE";
  /** Path relative to /api, e.g. "/tasks/12". May contain a temporary (negative) task id. */
  url: string;
  body?: Record<string, unknown>;
  /** For creates: the temporary id the UI is showing until the server assigns a real one. */
  tempId?: number;
}

const KEY = "tm_offline_queue";
const EVENT = "tm-queue-change";

let currentUser: number | null = null;
/** Idempotent so it can be called while rendering: the first fetch of the session must already know whose queue to overlay. */
export const setCurrentUser = (id: number | null) => {
  if (currentUser === id) return;
  currentUser = id;
  notify();
};

const notify = () => window.dispatchEvent(new Event(EVENT));

function read(): QueuedOp[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(ops: QueuedOp[]) {
  try {
    if (ops.length) localStorage.setItem(KEY, JSON.stringify(ops));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable or full: the change is still shown this session, just not persisted */
  }
  notify();
}

/** Operations belonging to the signed-in user. */
export const pendingOps = () => read().filter((o) => o.user === currentUser);

export function clearQueue() {
  write([]);
}

/** Deletes the service worker's cached API responses (the last-seen data shown offline). */
export async function clearApiCaches() {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith("tm-api-")).map((k) => caches.delete(k)));
}

/** Forget everything kept for offline use: queued changes and the cached API responses. Called on sign-out. */
export async function clearOfflineData() {
  clearQueue();
  await clearApiCaches();
}

/** Number of this user's changes waiting to sync. */
export function usePendingCount(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => pendingOps().length,
  );
}

const TASK_PATH = /^\/tasks(?:\/(-?\d+)(\/complete)?)?$/;

/**
 * Queues a write that failed for lack of connection. Returns a stand-in for the server's response, or null
 * when this kind of write can't be done offline.
 */
export function enqueue(method: string, url: string, body?: unknown): unknown | null {
  if (currentUser === null) return null;
  const m = url.match(TASK_PATH);
  if (!m) return null;
  const [, rawId, complete] = m;
  const op: Omit<QueuedOp, "method"> = { id: crypto.randomUUID(), user: currentUser, url };
  let reply: unknown;

  if (method === "POST" && !rawId) {
    const tempId = -Date.now();
    write([...read(), { ...op, method: "POST", body: body as Record<string, unknown>, tempId }]);
    reply = buildTempTask(tempId, body as Record<string, unknown>);
  } else if (method === "PATCH" && rawId && !complete) {
    write([...read(), { ...op, method: "PATCH", body: body as Record<string, unknown> }]);
    reply = {};
  } else if (method === "POST" && rawId && complete) {
    write([...read(), { ...op, method: "POST" }]);
    reply = { completed: {}, next: null };
  } else if (method === "DELETE" && rawId && !complete) {
    write([...read(), { ...op, method: "DELETE" }]);
    reply = undefined;
  } else {
    return null;
  }
  return reply;
}

function buildTempTask(id: number, b: Record<string, unknown>): Task {
  return {
    id, user_id: currentUser ?? 0, assignee_id: null, workspace_id: null, access: "admin", can_delete: true, comment_count: 0, meeting_count: 0, status_id: null,
    parent_id: null, project_id: null, title: "", notes: "", priority: 0, status: "todo", due_at: null, remind_at: null,
    recurrence: null, completed_at: null, created_at: new Date().toISOString().slice(0, 19).replace("T", " "), tags: [],
    position: Number.MAX_SAFE_INTEGER, estimate_min: null, blocked_by: [], blocked: false, subtasks_total: 0, subtasks_done: 0,
    checklist_total: 0, checklist_done: 0, tracked_min: 0, timer_running: false,
    ...(b as Partial<Task>),
  };
}

/** Shows queued changes on top of a task list fetched earlier (or served from the offline cache). */
export function overlayQueue(tasks: Task[]): Task[] {
  const ops = pendingOps();
  if (!ops.length) return tasks;
  let out = tasks.map((t) => ({ ...t }));
  for (const op of ops) {
    const m = op.url.match(TASK_PATH);
    const id = m?.[1] ? Number(m[1]) : null;
    if (op.method === "POST" && op.tempId !== undefined) {
      out.push(buildTempTask(op.tempId, op.body ?? {}));
    } else if (id !== null) {
      if (op.method === "DELETE") out = out.filter((t) => t.id !== id && t.parent_id !== id);
      else {
        const t = out.find((x) => x.id === id);
        if (!t) continue;
        if (m?.[2]) Object.assign(t, { status: "done", completed_at: new Date().toISOString() });
        else {
          Object.assign(t, op.body);
          if (op.body?.status) t.completed_at = op.body.status === "done" ? new Date().toISOString() : null;
        }
      }
    }
  }
  return out;
}

export interface FlushResult {
  sent: number;
  /** Changes the server rejected (e.g. the task was deleted elsewhere); they are dropped. */
  failed: number;
  /** True when we stopped early because the connection dropped again or the session expired. */
  interrupted: boolean;
}

let flushing = false;

/** Replays queued writes in order, mapping temporary ids to the real ones as creates succeed. */
export async function flushQueue(fetchImpl: typeof fetch = fetch): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, interrupted: false };
  if (flushing || currentUser === null) return result;
  flushing = true;
  try {
    const idMap = new Map<number, number>();
    const sub = (v: string) => v.replace(/-\d+/g, (s) => String(idMap.get(Number(s)) ?? s));

    for (const op of pendingOps()) {
      const body = op.body && JSON.parse(JSON.stringify(op.body, (_k, v) => (typeof v === "number" && idMap.has(v) ? idMap.get(v) : v)));
      let res: Response;
      try {
        res = await fetchImpl(`/api${sub(op.url)}`, {
          method: op.method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        result.interrupted = true;
        break;
      }
      if (res.status === 401 || res.status >= 500) {
        result.interrupted = true;
        break;
      }
      if (res.ok) {
        result.sent++;
        if (op.tempId !== undefined) idMap.set(op.tempId, ((await res.json()) as Task).id);
      } else {
        result.failed++;
      }
      write(read().filter((o) => o.id !== op.id));
    }
  } finally {
    flushing = false;
  }
  return result;
}
