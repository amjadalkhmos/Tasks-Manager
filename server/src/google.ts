import type { Express, Request, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { myArgs, myTasksSql } from "./access.js";
import type { DB, Queryable } from "./db.js";
import { HttpError } from "./http-error.js";
import { decrypt, encrypt } from "./secrets.js";

// ---------- Google API surface (swappable for tests) ----------

export interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}
export interface EventBody {
  summary: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
}
export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}
export interface GmailMessage {
  id: string;
  subject: string;
  snippet: string;
}

/** Thrown when Google rejects our credentials (revoked or expired grant): the user must reconnect. */
export class GoogleAuthError extends Error {}

export interface GoogleApi {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<{ tokens: GoogleTokens; email: string | null }>;
  refresh(refreshToken: string): Promise<{ access_token: string; expires_at: number }>;
  revoke(token: string): Promise<void>;
  listEvents(access: string, userMarker: string): Promise<GEvent[]>;
  insertEvent(access: string, userMarker: string, body: EventBody): Promise<GEvent>;
  patchEvent(access: string, id: string, body: Partial<EventBody>): Promise<GEvent>;
  deleteEvent(access: string, id: string): Promise<void>;
  listLabeledMessages(access: string, label: string): Promise<GmailMessage[]>;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfigFromEnv(env: NodeJS.ProcessEnv): GoogleConfig | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, PUBLIC_URL } = env;
  if (!clientId || !clientSecret || !PUBLIC_URL) return null;
  return { clientId, clientSecret, redirectUri: `${PUBLIC_URL.replace(/\/$/, "")}/api/integrations/google/callback` };
}

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

/** Real implementation over Google's REST endpoints. */
export function createGoogleApi(cfg: GoogleConfig, fetchImpl: typeof fetch = fetch): GoogleApi {
  const call = async <T>(url: string, init: RequestInit & { access?: string } = {}): Promise<T> => {
    const { access, ...rest } = init;
    const res = await fetchImpl(url, {
      ...rest,
      headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(rest.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || /invalid_grant/.test(text)) throw new GoogleAuthError("Google rejected the credentials");
      throw new Error(`Google API ${res.status}: ${text.slice(0, 200)}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  };

  const tokenRequest = (params: Record<string, string>) =>
    call<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string }>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }),
    });

  const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  return {
    authUrl: (state) =>
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: SCOPES,
        access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
      }),

    async exchangeCode(code) {
      const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
      if (!t.refresh_token) throw new Error("Google did not return a refresh token");
      // The id_token arrives directly from Google over TLS, so reading its payload without re-verifying is fine here.
      const email = t.id_token ? ((JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()) as { email?: string }).email ?? null) : null;
      return { tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 }, email };
    },

    async refresh(refreshToken) {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000 };
    },

    async revoke(token) {
      await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
    },

    async listEvents(access, marker) {
      const events: GEvent[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ privateExtendedProperty: marker, showDeleted: "true", singleEvents: "true", maxResults: "2500" });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await call<{ items?: GEvent[]; nextPageToken?: string }>(`${CAL}?${q}`, { access });
        events.push(...(page.items ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return events;
    },

    insertEvent(access, marker, body) {
      const [k, v] = marker.split("=");
      return call<GEvent>(CAL, {
        method: "POST", access, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, extendedProperties: { private: { [k]: v } } }),
      });
    },

    patchEvent: (access, id, body) =>
      call<GEvent>(`${CAL}/${encodeURIComponent(id)}`, { method: "PATCH", access, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),

    async deleteEvent(access, id) {
      try {
        await call<void>(`${CAL}/${encodeURIComponent(id)}`, { method: "DELETE", access });
      } catch (e) {
        if (!(e instanceof Error) || !/Google API (404|410)/.test(e.message)) throw e; // already gone is fine
      }
    },

    async listLabeledMessages(access, label) {
      const list = await call<{ messages?: { id: string }[] }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: `label:${label}`, maxResults: "25" })}`,
        { access },
      );
      return Promise.all(
        (list.messages ?? []).map(async ({ id }) => {
          const m = await call<{ snippet?: string; payload?: { headers?: { name: string; value: string }[] } }>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject`,
            { access },
          );
          const subject = m.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
          return { id, subject, snippet: m.snippet ?? "" };
        }),
      );
    },
  };
}

// ---------- sync ----------

export interface GoogleSettings {
  calendar: boolean;
  gmail: boolean;
  gmailLabel: string;
}
const DEFAULT_SETTINGS: GoogleSettings = { calendar: true, gmail: false, gmailLabel: "tasks" };

export interface SyncResult {
  calendar: { created: number; updated: number; pulled: number; removed: number } | null;
  gmail: { imported: number } | null;
}

const DEFAULT_EVENT_MIN = 30;
const same = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/** Shifts an instant into the person's wall clock (tz = minutes east of UTC) and reads it back with UTC getters. */
const wallClock = (iso: string, tz: number) => new Date(Date.parse(iso) + tz * 60_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function toEventBody(t: { title: string; due_at: string; estimate_min: number | null }, tz: number): EventBody {
  const wall = wallClock(t.due_at, tz);
  if (wall.getUTCHours() === 0 && wall.getUTCMinutes() === 0) {
    // Date-only due: an all-day event (Google's end date is exclusive).
    const next = new Date(wall.getTime() + 86_400_000);
    return { summary: t.title, start: { date: ymd(wall) }, end: { date: ymd(next) } };
  }
  const end = new Date(Date.parse(t.due_at) + (t.estimate_min || DEFAULT_EVENT_MIN) * 60_000);
  return { summary: t.title, start: { dateTime: new Date(t.due_at).toISOString() }, end: { dateTime: end.toISOString() } };
}

function eventDue(ev: GEvent, tz: number): string | null {
  if (ev.start?.date) {
    const [y, m, d] = ev.start.date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) - tz * 60_000).toISOString();
  }
  return ev.start?.dateTime ? new Date(ev.start.dateTime).toISOString() : null;
}

interface TaskRow {
  id: number;
  title: string;
  due_at: string | null;
  status: string;
  estimate_min: number | null;
}
interface LinkRow {
  task_id: number;
  event_id: string;
  due_synced: string;
  state: "active" | "removed";
}

export async function syncGoogle(
  db: Queryable,
  api: GoogleApi,
  userId: number,
  access: string,
  settings: GoogleSettings,
  tz: number,
): Promise<SyncResult> {
  const result: SyncResult = { calendar: null, gmail: null };

  if (settings.calendar) {
    const cal = (result.calendar = { created: 0, updated: 0, pulled: 0, removed: 0 });
    const marker = `tm_user=${userId}`;
    const events = new Map((await api.listEvents(access, marker)).map((e) => [e.id, e]));
    const alive = (id: string) => {
      const e = events.get(id);
      return !!e && e.status !== "cancelled";
    };
    // Tasks I made or that are assigned to me, and still visible to me (a removed teammate stops syncing shared work).
    const tasks = await db.all<TaskRow>(`SELECT t.id, t.title, t.due_at, t.status, t.estimate_min FROM tasks t WHERE ${myTasksSql("t")} ORDER BY t.id`, ...myArgs(userId));
    const links = new Map(
      (await db.all<LinkRow>("SELECT task_id, event_id, due_synced, state FROM gcal_links WHERE user_id = ?", userId)).map((l) => [l.task_id, l]),
    );
    const saveLink = (taskId: number, eventId: string, dueSynced: string) =>
      db.run(
        `INSERT INTO gcal_links (task_id, user_id, event_id, due_synced, state) VALUES (?, ?, ?, ?, 'active')
         ON CONFLICT(task_id) DO UPDATE SET event_id = excluded.event_id, due_synced = excluded.due_synced, state = 'active'`,
        taskId, userId, eventId, dueSynced,
      );

    for (const t of tasks) {
      const link = links.get(t.id);
      const wanted = t.status !== "done" && t.due_at ? { ...t, due_at: t.due_at } : null;

      if (!wanted) {
        if (link) {
          if (link.state === "active" && alive(link.event_id)) await api.deleteEvent(access, link.event_id);
          events.delete(link.event_id); // already handled; the orphan sweep below must not delete it again
          await db.run("DELETE FROM gcal_links WHERE task_id = ?", t.id);
          cal.removed++;
        }
        continue;
      }
      const create = async () => {
        const ev = await api.insertEvent(access, marker, toEventBody(wanted, tz));
        await saveLink(t.id, ev.id, wanted.due_at);
        events.set(ev.id, ev);
        cal.created++;
      };

      if (!link) {
        await create();
      } else if (link.state === "removed") {
        // The person deleted this event in Google; only bring it back if the due date has changed since.
        if (!same(wanted.due_at, link.due_synced)) await create();
      } else if (!alive(link.event_id)) {
        await db.run("UPDATE gcal_links SET state = 'removed' WHERE task_id = ?", t.id);
      } else {
        const ev = events.get(link.event_id)!;
        const remote = eventDue(ev, tz);
        if (!same(wanted.due_at, link.due_synced)) {
          // Local change wins when both sides moved.
          await api.patchEvent(access, link.event_id, toEventBody(wanted, tz));
          await saveLink(t.id, link.event_id, wanted.due_at);
          cal.updated++;
        } else if (remote && !same(remote, link.due_synced)) {
          await db.run("UPDATE tasks SET due_at = ? WHERE id = ?", remote, t.id);
          await saveLink(t.id, link.event_id, remote);
          cal.pulled++;
        } else if (ev.summary !== t.title) {
          await api.patchEvent(access, link.event_id, { summary: t.title });
          cal.updated++;
        }
      }
    }

    // Events we created whose task no longer exists (deleted tasks lose their link row).
    const linked = new Set((await db.all<{ event_id: string }>("SELECT event_id FROM gcal_links WHERE user_id = ?", userId)).map((l) => l.event_id));
    for (const [id, ev] of events) {
      if (ev.status !== "cancelled" && !linked.has(id)) {
        await api.deleteEvent(access, id);
        cal.removed++;
      }
    }
  }

  if (settings.gmail) {
    const gm = (result.gmail = { imported: 0 });
    const label = settings.gmailLabel.trim() || DEFAULT_SETTINGS.gmailLabel;
    for (const m of await api.listLabeledMessages(access, label)) {
      if (await db.get("SELECT 1 FROM gmail_seen WHERE user_id = ? AND message_id = ?", userId, m.id)) continue;
      const taskId = await db.insert(
        "INSERT INTO tasks (user_id, title, notes, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE user_id = ?))",
        userId, (m.subject.trim() || "(no subject)").slice(0, 500), `${m.snippet}\n\nhttps://mail.google.com/mail/u/0/#all/${m.id}`.slice(0, 10000), userId,
      );
      await db.run("INSERT INTO tags (user_id, name) VALUES (?, 'email') ON CONFLICT DO NOTHING", userId);
      const tag = (await db.get<{ id: number }>("SELECT id FROM tags WHERE user_id = ? AND name = 'email'", userId))!;
      await db.run("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING", taskId, tag.id);
      await db.run("INSERT INTO gmail_seen (user_id, message_id, task_id) VALUES (?, ?, ?)", userId, m.id, taskId);
      gm.imported++;
    }
  }
  return result;
}

// ---------- routes ----------

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
  api: GoogleApi | null;
  secret: string;
  key: Buffer;
}

const settingsPatch = z.object({ calendar: z.boolean(), gmail: z.boolean(), gmailLabel: z.string().min(1).max(100) }).partial();

export function registerGoogle(app: Express, { db, auth, uid, api, secret, key }: Deps) {
  const row = (userId: number) =>
    db.get<{ tokens_enc: string; account: string | null; settings_json: string; last_sync: string | null }>(
      "SELECT tokens_enc, account, settings_json, last_sync FROM integrations WHERE user_id = ? AND provider = 'google'",
      userId,
    );
  const settingsOf = (r: { settings_json: string }): GoogleSettings => ({ ...DEFAULT_SETTINGS, ...JSON.parse(r.settings_json) });
  const needApi = () => {
    if (!api) throw new HttpError(503, "Google integration is not configured on this server");
    return api;
  };

  app.get("/api/integrations", auth, async (req, res) => {
    const r = await row(uid(req));
    res.json({
      google: { configured: !!api, connected: !!r, account: r?.account ?? null, settings: r ? settingsOf(r) : DEFAULT_SETTINGS, last_sync: r?.last_sync ?? null },
    });
  });

  app.get("/api/integrations/google/connect", auth, (req, res) => {
    const state = jwt.sign({ sub: uid(req), purpose: "google-connect" }, secret, { expiresIn: "10m" });
    res.json({ url: needApi().authUrl(state) });
  });

  // Google redirects the browser here. The signed `state` (not the cookie) says which user is connecting.
  app.get("/api/integrations/google/callback", async (req, res) => {
    const g = needApi();
    const { code, state, error } = req.query as Record<string, string | undefined>;
    try {
      if (error || !code || !state) throw new Error(error ?? "missing code");
      const payload = jwt.verify(state, secret) as jwt.JwtPayload;
      if (payload.purpose !== "google-connect") throw new Error("bad state");
      const { tokens, email } = await g.exchangeCode(code);
      await db.run(
        `INSERT INTO integrations (user_id, provider, tokens_enc, account, settings_json) VALUES (?, 'google', ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET tokens_enc = excluded.tokens_enc, account = excluded.account`,
        Number(payload.sub), encrypt(key, JSON.stringify(tokens)), email, JSON.stringify(DEFAULT_SETTINGS),
      );
      res.redirect("/settings?google=connected");
    } catch (e) {
      console.error("Google connect failed:", e instanceof Error ? e.message : e);
      res.redirect("/settings?google=error");
    }
  });

  app.patch("/api/integrations/google/settings", auth, async (req, res) => {
    const r = await row(uid(req));
    if (!r) throw new HttpError(404, "Google is not connected");
    const next = { ...settingsOf(r), ...settingsPatch.parse(req.body) };
    await db.run("UPDATE integrations SET settings_json = ? WHERE user_id = ? AND provider = 'google'", JSON.stringify(next), uid(req));
    res.json(next);
  });

  const syncQuery = z.object({ tz: z.coerce.number().int().min(-840).max(840).default(0) });

  app.post("/api/integrations/google/sync", auth, async (req, res) => {
    const g = needApi();
    const { tz } = syncQuery.parse(req.query);
    const r = await row(uid(req));
    if (!r) throw new HttpError(404, "Google is not connected");
    try {
      let tokens = JSON.parse(decrypt(key, r.tokens_enc)) as GoogleTokens;
      if (tokens.expires_at - Date.now() < 60_000) {
        tokens = { ...tokens, ...(await g.refresh(tokens.refresh_token)) };
        await db.run("UPDATE integrations SET tokens_enc = ? WHERE user_id = ? AND provider = 'google'", encrypt(key, JSON.stringify(tokens)), uid(req));
      }
      const result = await syncGoogle(db, g, uid(req), tokens.access_token, settingsOf(r), tz);
      const now = new Date().toISOString();
      await db.run("UPDATE integrations SET last_sync = ? WHERE user_id = ? AND provider = 'google'", now, uid(req));
      res.json({ ...result, last_sync: now });
    } catch (e) {
      if (e instanceof GoogleAuthError) throw new HttpError(409, "Google access was revoked or expired — disconnect and connect again");
      throw e;
    }
  });

  app.delete("/api/integrations/google", auth, async (req, res) => {
    const r = await row(uid(req));
    if (r && api) {
      try {
        const tokens = JSON.parse(decrypt(key, r.tokens_enc)) as GoogleTokens;
        await api.revoke(tokens.refresh_token);
      } catch {
        /* revoking is best-effort; the local credentials are removed regardless */
      }
    }
    await db.run("DELETE FROM integrations WHERE user_id = ? AND provider = 'google'", uid(req));
    await db.run("DELETE FROM gcal_links WHERE user_id = ?", uid(req));
    res.status(204).end();
  });
}
