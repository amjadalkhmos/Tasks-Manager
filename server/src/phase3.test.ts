import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { createApp } from "./app.js";
import type { DB } from "./db.js";
import { testDb } from "./test-db.js";
import { parseCsv, toCsv } from "./csv.js";
import type { AiClient } from "./ai.js";
import { GoogleAuthError, type EventBody, type GEvent, type GmailMessage, type GoogleApi } from "./google.js";
import { decrypt, encrypt, makeKey } from "./secrets.js";

type Agent = ReturnType<typeof request.agent>;
type App = ReturnType<typeof createApp>;

async function login(app: App, email = "a@example.com"): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "password123" }).expect(201);
  return agent;
}
const mk = async (agent: Agent, body: object) => (await agent.post("/api/tasks").send(body).expect(201)).body;

// ---------- CSV ----------

describe("csv", () => {
  it("round-trips quotes, commas, newlines and CRLF", () => {
    const rows = [["a", 'he said "hi", ok', "line1\nline2"], ["x", "", "y"]];
    expect(parseCsv(toCsv(rows))).toEqual([rows[0], ["x", "", "y"]]);
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("neutralises spreadsheet formulas in text but not numbers", () => {
    const out = toCsv([["=SUM(A1)", "+1", "-2", "@x", -5, "ok"]]);
    expect(out).toBe("'=SUM(A1),'+1,'-2,'@x,-5,ok\r\n");
  });
});

// ---------- import / export ----------

describe("export and import", () => {
  let app: App;
  let agent: Agent;
  beforeEach(async () => {
    app = createApp(await testDb(), "s");
    agent = await login(app);
  });

  it("round-trips everything through JSON into another account", async () => {
    const proj = (await agent.post("/api/projects").send({ name: "Home" }).expect(201)).body;
    const parent = await mk(agent, { title: "Move", project_id: proj.id, priority: 2, tags: ["urgent"], due_at: "2026-05-01T09:00:00.000Z", estimate_min: 90 });
    const child = await mk(agent, { title: "Pack", parent_id: parent.id });
    const rec = await mk(agent, { title: "Water plants", recurrence: { freq: "weekly", interval: 2, weekdays: [1] } });
    await agent.post(`/api/tasks/${parent.id}/checklist`).send({ text: "boxes" }).expect(201);
    await agent.post(`/api/tasks/${child.id}/deps`).send({ blocked_by_id: rec.id }).expect(201);
    await agent.post("/api/filters").send({ name: "Urgent", query: { tag: "urgent" } }).expect(201);

    const exported = (await agent.get("/api/export").expect(200)).body;
    expect(exported.version).toBe(1);
    expect(exported.tasks).toHaveLength(3);

    const other = await login(app, "b@example.com");
    const res = (await other.post("/api/import?format=json").send(exported).expect(201)).body;
    expect(res).toMatchObject({ tasks: 3, projects: 1, filters: 1, warnings: [] });

    const tasks = (await other.get("/api/tasks")).body as { id: number; title: string; parent_id: number | null; [k: string]: unknown }[];
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle["Pack"].parent_id).toBe(byTitle["Move"].id);
    expect(byTitle["Move"]).toMatchObject({ priority: 2, tags: ["urgent"], estimate_min: 90, due_at: "2026-05-01T09:00:00.000Z" });
    expect(byTitle["Move"].checklist_total).toBe(1);
    expect(byTitle["Water plants"].recurrence).toEqual({ freq: "weekly", interval: 2, weekdays: [1] });
    expect(byTitle["Pack"].blocked_by).toEqual([byTitle["Water plants"].id]);
    expect((await other.get("/api/filters")).body).toHaveLength(1);
    expect((await other.get("/api/projects")).body.map((p: { name: string }) => p.name)).toEqual(["Home"]);
    // the original account is untouched
    expect((await agent.get("/api/tasks")).body).toHaveLength(3);
  });

  it("skips dependencies that would form a cycle and reports it", async () => {
    const body = {
      version: 1,
      tasks: [
        { id: 1, title: "a", blocked_by: [2] },
        { id: 2, title: "b", blocked_by: [1] },
      ],
    };
    const res = (await agent.post("/api/import?format=json").send(body).expect(201)).body;
    expect(res.warnings.join()).toMatch(/cycle/);
  });

  it("rejects malformed or mismatched payloads", async () => {
    await agent.post("/api/import?format=json").send({ version: 2, tasks: [] }).expect(400);
    await agent.post("/api/import?format=csv").send({ title: "x" }).expect(415);
    await agent.post("/api/import?format=json").set("Content-Type", "text/csv").send("title\nx").expect(415);
    await agent.post("/api/import?format=json").set("Content-Type", "application/json").send("{not json").expect(400);
    await agent.post("/api/import?format=nope").send({}).expect(400);
    await request(app).post("/api/import?format=json").send({ version: 1, tasks: [] }).expect(401);
  });

  it("exports CSV that survives a re-import, with formulas defused", async () => {
    await mk(agent, { title: "=HYPERLINK(\"http://evil\")", tags: ["a", "b"], priority: 3 });
    await mk(agent, { title: 'Quote "me", please', notes: "two\nlines" });
    const csv = (await agent.get("/api/export.csv").expect(200)).text;
    expect(csv.split("\r\n")[0]).toBe("id,parent_id,title,notes,project,priority,status,due_at,remind_at,recurrence,tags,estimate_min,completed_at");
    expect(csv).toContain("'=HYPERLINK");

    const other = await login(app, "b@example.com");
    const res = (await other.post("/api/import?format=csv").set("Content-Type", "text/csv").send(csv).expect(201)).body;
    expect(res.tasks).toBe(2);
    const titles = (await other.get("/api/tasks")).body.map((t: { title: string }) => t.title).sort();
    expect(titles).toEqual(['=HYPERLINK("http://evil")', 'Quote "me", please']); // the defusing apostrophe is stripped again
  });

  it("imports a Todoist CSV: nesting, priorities, dates in the person's timezone, recurring warning", async () => {
    const csv = [
      "TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE",
      "section,Errands,,,,,,,,",
      "task,Buy milk,2 litres,1,1,Me,,2026-03-04,en,",
      "task,Whole milk,,4,2,Me,,,en,",
      "task,Oat milk,,3,2,Me,,,en,",
      "task,Water plants,,4,1,Me,,every week,en,",
      "task,Call bank,,2,1,Me,,someday soon,en,",
      "note,ignored,,,,,,,,",
    ].join("\n");
    const res = (await agent.post("/api/import?format=todoist&project=Errands&tz=180").set("Content-Type", "text/csv").send(csv).expect(201)).body;
    expect(res.tasks).toBe(5);
    expect(res.warnings.join(" ")).toMatch(/1 recurring/);
    expect(res.warnings.join(" ")).toMatch(/someday soon/);

    const tasks = (await agent.get("/api/tasks")).body as Record<string, any>[];
    const t = Object.fromEntries(tasks.map((x) => [x.title, x]));
    expect(t["Buy milk"]).toMatchObject({ priority: 3, notes: "2 litres", due_at: "2026-03-03T21:00:00.000Z" }); // local midnight at UTC+3
    expect(t["Whole milk"].parent_id).toBe(t["Buy milk"].id);
    expect(t["Oat milk"].parent_id).toBe(t["Buy milk"].id);
    expect(t["Oat milk"].priority).toBe(1);
    expect(t["Call bank"].priority).toBe(2);
    expect(tasks.every((x) => x.project_id === t["Buy milk"].project_id)).toBe(true);
    expect((await agent.get("/api/projects")).body.map((p: { name: string }) => p.name)).toEqual(["Errands"]);
  });

  it("imports a Trello board: lists→status, labels→tags, checklists, archived skipped", async () => {
    const board = {
      name: "Launch",
      lists: [
        { id: "l1", name: "Backlog" },
        { id: "l2", name: "In Progress" },
        { id: "l3", name: "Done" },
        { id: "l4", name: "Old", closed: true },
      ],
      cards: [
        { id: "c1", name: "Design", desc: "mockups", idList: "l2", due: "2026-04-01T12:00:00.000Z", labels: [{ name: "UI" }, {}] },
        { id: "c2", name: "Ship", idList: "l3" },
        { id: "c3", name: "Idea", idList: "l1", closed: true },
        { id: "c4", name: "Legacy", idList: "l4" },
      ],
      checklists: [{ idCard: "c1", checkItems: [{ name: "wireframes", state: "complete", pos: 1 }, { name: "review", state: "incomplete", pos: 2 }] }],
    };
    const res = (await agent.post("/api/import?format=trello").send(board).expect(201)).body;
    expect(res.tasks).toBe(2);
    expect(res.warnings.join()).toMatch(/2 archived/);
    const tasks = (await agent.get("/api/tasks")).body as Record<string, any>[];
    const t = Object.fromEntries(tasks.map((x) => [x.title, x]));
    expect(t["Design"]).toMatchObject({ status: "doing", tags: ["ui"], due_at: "2026-04-01T12:00:00.000Z", checklist_total: 2, checklist_done: 1 });
    expect(t["Ship"].status).toBe("done");
    expect((await agent.get(`/api/tasks/${t["Design"].id}/checklist`)).body.map((c: { text: string }) => c.text)).toEqual(["wireframes", "review"]);
    expect((await agent.get("/api/projects")).body[0].name).toBe("Launch");
  });
});

// ---------- AI ----------

describe("AI endpoints", () => {
  const fake = (): AiClient & { calls: string[] } => ({
    calls: [],
    async breakdown(task) {
      this.calls.push(`breakdown:${task.title}`);
      return ["  Draft outline ", "", "Write intro", "Review", "4", "5", "6", "7", "8", "9"];
    },
    async planDay({ tasks }) {
      this.calls.push("plan");
      return {
        summary: " A focused day. ",
        order: [
          { id: tasks[0].id, reason: "Overdue" },
          { id: 999999, reason: "not a real task" },
          { id: tasks[0].id, reason: "duplicate" },
        ],
      };
    },
  });

  it("reports disabled state and refuses to run without a client", async () => {
    const app = createApp(await testDb(), "s");
    const agent = await login(app);
    expect((await agent.get("/api/ai/status")).body).toEqual({ enabled: false });
    const t = await mk(agent, { title: "x" });
    await agent.post(`/api/tasks/${t.id}/ai/breakdown`).expect(503);
    await agent.post("/api/ai/plan-day").expect(503);
  });

  it("suggests cleaned, capped subtasks without creating them, only for the owner", async () => {
    const ai = fake();
    const app = createApp(await testDb(), "s", { ai });
    const agent = await login(app);
    const t = await mk(agent, { title: "Write report" });
    expect((await agent.get("/api/ai/status")).body.enabled).toBe(true);
    const { subtasks } = (await agent.post(`/api/tasks/${t.id}/ai/breakdown`).expect(200)).body;
    expect(subtasks).toEqual(["Draft outline", "Write intro", "Review", "4", "5", "6", "7", "8"]);
    expect((await agent.get("/api/tasks")).body).toHaveLength(1); // nothing created
    const other = await login(app, "b@example.com");
    await other.post(`/api/tasks/${t.id}/ai/breakdown`).expect(404);
    expect(ai.calls).toEqual(["breakdown:Write report"]);
  });

  it("plans the day using only the person's own open tasks, dropping invented or repeated ids", async () => {
    const ai = fake();
    const app = createApp(await testDb(), "s", { ai });
    const agent = await login(app);
    await agent.post("/api/ai/plan-day").expect(200).then((r) => expect(r.body.order).toEqual([]));
    expect(ai.calls).toEqual([]); // no tasks → no model call
    const t = await mk(agent, { title: "Pay rent", due_at: "2026-01-01T00:00:00.000Z" });
    const { body } = await agent.post("/api/ai/plan-day?tz=180").expect(200);
    expect(body.summary).toBe("A focused day.");
    expect(body.order).toEqual([{ id: t.id, title: "Pay rent", reason: "Overdue" }]);
  });

  it("rate limits per person", async () => {
    const app = createApp(await testDb(), "s", { ai: fake() });
    const agent = await login(app);
    const t = await mk(agent, { title: "x" });
    for (let i = 0; i < 20; i++) await agent.post(`/api/tasks/${t.id}/ai/breakdown`).expect(200);
    await agent.post(`/api/tasks/${t.id}/ai/breakdown`).expect(429);
    const other = await login(app, "b@example.com");
    const t2 = await mk(other, { title: "y" });
    await other.post(`/api/tasks/${t2.id}/ai/breakdown`).expect(200);
  });

  it("builds a structured-output format from zod 4 schemas", () => {
    const fmt = zodOutputFormat(z.object({ subtasks: z.array(z.string()) }));
    expect(fmt.type).toBe("json_schema");
    expect(JSON.stringify(fmt.schema)).toContain("subtasks");
  });
});

// ---------- secrets ----------

describe("secrets", () => {
  it("encrypts with a random IV and rejects tampering or a wrong key", () => {
    const key = makeKey(undefined, "secret");
    const a = encrypt(key, "refresh-token");
    expect(encrypt(key, "refresh-token")).not.toBe(a);
    expect(a).not.toContain("refresh-token");
    expect(decrypt(key, a)).toBe("refresh-token");
    expect(() => decrypt(makeKey(undefined, "other"), a)).toThrow();
    const [iv, tag, body] = a.split(".");
    const flipped = Buffer.from(body, "base64");
    flipped[0] ^= 1;
    expect(() => decrypt(key, [iv, tag, flipped.toString("base64")].join("."))).toThrow();
    expect(() => makeKey("c2hvcnQ=", "x")).toThrow(/32 bytes/);
  });
});

// ---------- Google ----------

class FakeGoogle implements GoogleApi {
  events = new Map<string, GEvent & { owner: string }>();
  messages: GmailMessage[] = [];
  revoked: string[] = [];
  failAuth = false;
  refreshCount = 0;
  nextTokens = { access_token: "acc-1", refresh_token: "ref-1", expires_at: Date.now() + 3_600_000 };
  private n = 0;
  authUrl = (state: string) => `https://accounts.example/auth?state=${encodeURIComponent(state)}`;
  exchangeCode = async (code: string) => {
    if (code === "bad") throw new Error("exchange failed");
    return { tokens: this.nextTokens, email: "me@gmail.test" };
  };
  refresh = async () => {
    this.refreshCount++;
    return { access_token: "acc-2", expires_at: Date.now() + 3_600_000 };
  };
  revoke = async (t: string) => void this.revoked.push(t);
  private guard() {
    if (this.failAuth) throw new GoogleAuthError("revoked");
  }
  listEvents = async (_a: string, marker: string) => {
    this.guard();
    return [...this.events.values()].filter((e) => `tm_user=${e.owner}` === marker);
  };
  insertEvent = async (_a: string, marker: string, body: EventBody) => {
    const id = `ev${++this.n}`;
    const ev = { id, ...body, status: "confirmed", owner: marker.split("=")[1] };
    this.events.set(id, ev);
    return ev;
  };
  patchEvent = async (_a: string, id: string, body: Partial<EventBody>) => {
    const ev = this.events.get(id)!;
    Object.assign(ev, body);
    return ev;
  };
  deleteEvent = async (_a: string, id: string) => void this.events.delete(id);
  listLabeledMessages = async (_a: string, label: string) => (label === "tasks" ? this.messages : []);
}

describe("Google integration", () => {
  let db: DB;
  let app: App;
  let agent: Agent;
  let google: FakeGoogle;
  let userId: number;

  const connect = async (a: Agent = agent) => {
    const { url } = (await a.get("/api/integrations/google/connect").expect(200)).body;
    const state = new URL(url).searchParams.get("state")!;
    return request(app).get(`/api/integrations/google/callback?code=good&state=${encodeURIComponent(state)}`);
  };
  const sync = (tz = 0) => agent.post(`/api/integrations/google/sync?tz=${tz}`);

  beforeEach(async () => {
    db = await testDb();
    google = new FakeGoogle();
    app = createApp(db, "s", { google });
    agent = await login(app);
    userId = (await agent.get("/api/auth/me")).body.id;
  });

  it("is unavailable when not configured", async () => {
    const bare = createApp(await testDb(), "s");
    const a = await login(bare);
    expect((await a.get("/api/integrations")).body.google).toMatchObject({ configured: false, connected: false });
    await a.get("/api/integrations/google/connect").expect(503);
  });

  it("connects via a signed state, stores tokens encrypted, and can disconnect", async () => {
    await connect().then((r) => expect(r.headers.location).toBe("/settings?google=connected"));
    const stored = (await db.get<{ tokens_enc: string; account: string }>("SELECT tokens_enc, account FROM integrations"))!;
    expect(stored.account).toBe("me@gmail.test");
    expect(stored.tokens_enc).not.toContain("ref-1");
    expect(decrypt(makeKey(undefined, "s"), stored.tokens_enc)).toContain("ref-1");
    expect((await agent.get("/api/integrations")).body.google).toMatchObject({ configured: true, connected: true, account: "me@gmail.test" });

    await agent.delete("/api/integrations/google").expect(204);
    expect(google.revoked).toEqual(["ref-1"]);
    expect((await agent.get("/api/integrations")).body.google.connected).toBe(false);
  });

  it("rejects forged, wrong-purpose and failed callbacks without storing anything", async () => {
    const forged = await request(app).get("/api/integrations/google/callback?code=good&state=garbage");
    expect(forged.headers.location).toBe("/settings?google=error");
    const jwt = (await import("jsonwebtoken")).default;
    const wrongPurpose = jwt.sign({ sub: userId, purpose: "something-else" }, "s");
    expect((await request(app).get(`/api/integrations/google/callback?code=good&state=${wrongPurpose}`)).headers.location).toBe("/settings?google=error");
    const okState = jwt.sign({ sub: userId, purpose: "google-connect" }, "s");
    expect((await request(app).get(`/api/integrations/google/callback?code=bad&state=${okState}`)).headers.location).toBe("/settings?google=error");
    expect((await request(app).get("/api/integrations/google/callback?error=access_denied")).headers.location).toBe("/settings?google=error");
    expect(await db.get("SELECT COUNT(*) AS n FROM integrations")).toEqual({ n: 0 });
    await sync().expect(404);
  });

  it("pushes due tasks as events, all-day for date-only and timed otherwise", async () => {
    await connect();
    await mk(agent, { title: "Timed", due_at: "2026-03-04T12:00:00.000Z", estimate_min: 45 });
    await mk(agent, { title: "All day", due_at: "2026-03-03T21:00:00.000Z" }); // local midnight Mar 4 at UTC+3
    await mk(agent, { title: "No date" });
    const r = (await sync(180).expect(200)).body;
    expect(r.calendar).toMatchObject({ created: 2, updated: 0, pulled: 0, removed: 0 });
    const evs = [...google.events.values()];
    expect(evs.find((e) => e.summary === "Timed")).toMatchObject({
      start: { dateTime: "2026-03-04T12:00:00.000Z" }, end: { dateTime: "2026-03-04T12:45:00.000Z" },
    });
    expect(evs.find((e) => e.summary === "All day")).toMatchObject({ start: { date: "2026-03-04" }, end: { date: "2026-03-05" } });
    // a second sync with no changes does nothing
    expect((await sync(180)).body.calendar).toEqual({ created: 0, updated: 0, pulled: 0, removed: 0 });
    expect(google.events.size).toBe(2);
  });

  it("two-way: local changes win, remote moves are pulled, titles follow", async () => {
    await connect();
    const t = await mk(agent, { title: "Report", due_at: "2026-03-04T12:00:00.000Z" });
    await sync();
    const ev = [...google.events.values()][0];

    // moved in Google → pulled into the task
    ev.start = { dateTime: "2026-03-05T08:00:00+00:00" };
    expect((await sync()).body.calendar.pulled).toBe(1);
    expect((await agent.get(`/api/tasks/${t.id}`)).body.due_at).toBe("2026-03-05T08:00:00.000Z");

    // moved locally → pushed
    await agent.patch(`/api/tasks/${t.id}`).send({ due_at: "2026-03-06T10:00:00.000Z" }).expect(200);
    expect((await sync()).body.calendar.updated).toBe(1);
    expect(ev.start).toEqual({ dateTime: "2026-03-06T10:00:00.000Z" });

    // both moved → local wins
    ev.start = { dateTime: "2026-03-09T10:00:00.000Z" };
    await agent.patch(`/api/tasks/${t.id}`).send({ due_at: "2026-03-07T10:00:00.000Z" }).expect(200);
    await sync();
    expect(ev.start).toEqual({ dateTime: "2026-03-07T10:00:00.000Z" });
    expect((await agent.get(`/api/tasks/${t.id}`)).body.due_at).toBe("2026-03-07T10:00:00.000Z");

    // rename → pushed
    await agent.patch(`/api/tasks/${t.id}`).send({ title: "Report v2" }).expect(200);
    await sync();
    expect(ev.summary).toBe("Report v2");
  });

  it("removes events when tasks are completed or deleted, and cleans up orphans", async () => {
    await connect();
    const done = await mk(agent, { title: "Done soon", due_at: "2026-03-04T12:00:00.000Z" });
    const gone = await mk(agent, { title: "Deleted", due_at: "2026-03-05T12:00:00.000Z" });
    const dateless = await mk(agent, { title: "Lose date", due_at: "2026-03-06T12:00:00.000Z" });
    await sync();
    expect(google.events.size).toBe(3);

    await agent.post(`/api/tasks/${done.id}/complete`).expect(200);
    await agent.delete(`/api/tasks/${gone.id}`).expect(204);
    await agent.patch(`/api/tasks/${dateless.id}`).send({ due_at: null }).expect(200);
    const r = (await sync()).body.calendar;
    expect(r.removed).toBe(3);
    expect(google.events.size).toBe(0);
  });

  it("respects an event deleted in Google until the due date changes", async () => {
    await connect();
    const t = await mk(agent, { title: "Dentist", due_at: "2026-03-04T12:00:00.000Z" });
    await sync();
    google.events.clear();
    await sync();
    expect(google.events.size).toBe(0); // not silently recreated
    await sync();
    expect(google.events.size).toBe(0);
    await agent.patch(`/api/tasks/${t.id}`).send({ due_at: "2026-03-10T12:00:00.000Z" }).expect(200);
    await sync();
    expect(google.events.size).toBe(1);
  });

  it("only touches the connected person's events", async () => {
    await connect();
    google.events.set("foreign", { id: "foreign", summary: "Someone else", owner: "9999", start: { date: "2026-01-01" } });
    await mk(agent, { title: "Mine", due_at: "2026-03-04T12:00:00.000Z" });
    await sync();
    expect(google.events.has("foreign")).toBe(true);
  });

  it("imports labelled Gmail messages once, as tagged tasks", async () => {
    await connect();
    await agent.patch("/api/integrations/google/settings").send({ calendar: false, gmail: true }).expect(200);
    google.messages = [
      { id: "m1", subject: "Invoice #42", snippet: "Please pay by Friday" },
      { id: "m2", subject: "", snippet: "no subject here" },
    ];
    expect((await sync()).body.gmail).toEqual({ imported: 2 });
    expect((await sync()).body.gmail).toEqual({ imported: 0 });
    const tasks = (await agent.get("/api/tasks")).body as Record<string, any>[];
    expect(tasks.map((t) => t.title).sort()).toEqual(["(no subject)", "Invoice #42"]);
    const inv = tasks.find((t) => t.title === "Invoice #42")!;
    expect(inv.tags).toEqual(["email"]);
    expect(inv.notes).toContain("Please pay by Friday");
    expect(inv.notes).toContain("https://mail.google.com/mail/u/0/#all/m1");
    // deleting the task does not make the message come back
    await agent.delete(`/api/tasks/${inv.id}`).expect(204);
    expect((await sync()).body.gmail).toEqual({ imported: 0 });
    // a different label finds nothing
    await agent.patch("/api/integrations/google/settings").send({ gmailLabel: "other" }).expect(200);
    google.messages.push({ id: "m3", subject: "new", snippet: "" });
    expect((await sync()).body.gmail).toEqual({ imported: 0 });
  });

  it("refreshes an expiring access token and tells the person to reconnect when access is revoked", async () => {
    google.nextTokens = { access_token: "old", refresh_token: "ref-1", expires_at: Date.now() + 1000 };
    await connect();
    await sync().expect(200);
    expect(google.refreshCount).toBe(1);
    await sync().expect(200); // refreshed token is stored, so no second refresh
    expect(google.refreshCount).toBe(1);

    google.failAuth = true;
    const res = await sync().expect(409);
    expect(res.body.error).toMatch(/connect again/);
  });

  it("keeps connections private between users", async () => {
    await connect();
    const other = await login(app, "b@example.com");
    expect((await other.get("/api/integrations")).body.google.connected).toBe(false);
    await other.post("/api/integrations/google/sync").expect(404);
    await other.patch("/api/integrations/google/settings").send({ gmail: true }).expect(404);
    await request(app).get("/api/integrations").expect(401);
  });
});
