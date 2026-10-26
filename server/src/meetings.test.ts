import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import type { DB } from "./db.js";
import { testDb } from "./test-db.js";

process.env.BCRYPT_ROUNDS = "4";

type Agent = ReturnType<typeof request.agent>;
type Json = Record<string, any>;

interface Team {
  db: DB;
  alice: Agent; // owner
  bob: Agent; // admin
  carol: Agent; // member
  dave: Agent; // viewer
  erin: Agent; // outsider
  ws: number;
  project: number;
}

async function makeTeam(): Promise<Team> {
  const db = await testDb();
  const app = createApp(db, "s");
  const signup = async (name: string) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ email: `${name}@example.com`, password: "password123", name }).expect(201);
    return agent;
  };
  const [alice, bob, carol, dave, erin] = await Promise.all(["alice", "bob", "carol", "dave", "erin"].map(signup));
  const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  for (const [agent, email, role] of [[bob, "bob", "admin"], [carol, "carol", "member"], [dave, "dave", "viewer"]] as const) {
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: `${email}@example.com`, role }).expect(201);
    const invite = ((await agent.get("/api/invites")).body as Json[])[0];
    await agent.post(`/api/invites/${invite.id}/accept`).expect(200);
  }
  const project = (await alice.post("/api/projects").send({ name: "Launch", workspace_id: ws }).expect(201)).body.id as number;
  return { db, alice, bob, carol, dave, erin, ws, project };
}

const task = async (a: Agent, body: object) => (await a.post("/api/tasks").send(body).expect(201)).body as Json;
const meeting = async (a: Agent, body: object, status = 201) => (await a.post("/api/meetings").send(body).expect(status)).body as Json;
const HOUR = 3_600_000;
const at = (offsetHours: number) => new Date(Date.now() + offsetHours * HOUR).toISOString();

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});

describe("creating and editing meetings", () => {
  it("creates a meeting with sensible defaults", async () => {
    const m = await meeting(t.alice, { title: "Kickoff", starts_at: "2026-03-04T10:00:00.000Z" });
    expect(m).toMatchObject({
      title: "Kickoff", starts_at: "2026-03-04T10:00:00.000Z", ends_at: "2026-03-04T10:30:00.000Z", // 30 minutes when no end is given
      location: "", url: "", notes: "", workspace_id: null, task_ids: [], source: "local", external_url: null, access: "admin", can_delete: true,
    });
    expect((await t.alice.get(`/api/meetings/${m.id}`)).body).toEqual(m);
  });

  it("stores location, link and notes, and trims the title", async () => {
    const m = await meeting(t.alice, {
      title: "  Design review  ", starts_at: at(1), ends_at: at(2), location: "Room 4", url: "https://meet.example.com/abc", notes: "Bring mockups",
    });
    expect(m).toMatchObject({ title: "Design review", location: "Room 4", url: "https://meet.example.com/abc", notes: "Bring mockups" });
  });

  it("rejects bad input", async () => {
    await meeting(t.alice, { starts_at: at(1) }, 400); // no title
    await meeting(t.alice, { title: "  ", starts_at: at(1) }, 400);
    await meeting(t.alice, { title: "x" }, 400); // no start
    await meeting(t.alice, { title: "x", starts_at: "tomorrow" }, 400);
    await meeting(t.alice, { title: "x", starts_at: at(2), ends_at: at(1) }, 400); // ends before it starts
    await meeting(t.alice, { title: "x".repeat(201), starts_at: at(1) }, 400);
    await meeting(t.alice, { title: "x", starts_at: at(1), url: "not a link" }, 400);
  });

  it("only accepts web links, since the link is shown as clickable", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://example.com/x", "file:///etc/passwd", "//evil.example"]) {
      await meeting(t.alice, { title: "x", starts_at: at(1), url: bad }, 400);
    }
    for (const good of ["http://example.com", "https://zoom.us/j/123?pwd=abc#x", ""]) {
      await meeting(t.alice, { title: "x", starts_at: at(1), url: good });
    }
    const m = await meeting(t.alice, { title: "edit", starts_at: at(1) });
    await t.alice.patch(`/api/meetings/${m.id}`).send({ url: "javascript:alert(1)" }).expect(400);
  });

  it("edits fields, and moving the start keeps the meeting's length", async () => {
    const m = await meeting(t.alice, { title: "Sync", starts_at: "2026-03-04T10:00:00.000Z", ends_at: "2026-03-04T11:15:00.000Z" });
    const moved = (await t.alice.patch(`/api/meetings/${m.id}`).send({ starts_at: "2026-03-05T14:00:00.000Z", title: "Sync v2" }).expect(200)).body;
    expect(moved).toMatchObject({ title: "Sync v2", starts_at: "2026-03-05T14:00:00.000Z", ends_at: "2026-03-05T15:15:00.000Z" });
    await t.alice.patch(`/api/meetings/${m.id}`).send({ ends_at: "2026-03-05T13:00:00.000Z" }).expect(400); // would end before the start
    await t.alice.patch(`/api/meetings/${m.id}`).send({ location: "Zoom" }).expect(200);
  });

  it("ignores attempts to set calendar-sync fields", async () => {
    const m = await meeting(t.alice, { title: "x", starts_at: at(1), source: "google", external_id: "evt1", external_url: "https://calendar.google.com/x" });
    expect(m).toMatchObject({ source: "local", external_url: null });
    await t.alice.patch(`/api/meetings/${m.id}`).send({ source: "google", external_url: "https://evil.example" }).expect(200);
    expect((await t.alice.get(`/api/meetings/${m.id}`)).body).toMatchObject({ source: "local", external_url: null });
  });

  it("is ready for calendar sync: external meetings are unique per person and source", async () => {
    // What a future Google sync would write. It goes through the database, not the API.
    const uid = (await t.alice.get("/api/auth/me")).body.id;
    const insert = (id: string) =>
      t.db.insert("INSERT INTO meetings (user_id, title, starts_at, ends_at, source, external_id, external_url) VALUES (?, ?, ?, ?, 'google', ?, ?)", uid, "From Google", at(1), at(2), id, `https://calendar.google.com/event?eid=${id}`);
    const id = await insert("evt-1");
    await expect(insert("evt-1")).rejects.toThrow(/unique|duplicate/i); // a second sync can't create a duplicate
    await insert("evt-2");
    const read = (await t.alice.get(`/api/meetings/${id}`)).body;
    expect(read).toMatchObject({ source: "google", external_url: "https://calendar.google.com/event?eid=evt-1" });
    // local meetings (no external id) are not affected by the uniqueness rule
    await meeting(t.alice, { title: "a", starts_at: at(1) });
    await meeting(t.alice, { title: "b", starts_at: at(1) });
    await expect(t.db.insert("INSERT INTO meetings (user_id, title, starts_at, ends_at, source) VALUES (?, ?, ?, ?, 'outlook')", uid, "x", at(1), at(2))).rejects.toThrow(); // unknown source
  });

  it("deletes a meeting without touching its tasks", async () => {
    const tk = await task(t.alice, { title: "Prep" });
    const m = await meeting(t.alice, { title: "Call", starts_at: at(1), task_ids: [tk.id] });
    await t.alice.delete(`/api/meetings/${m.id}`).expect(204);
    await t.alice.get(`/api/meetings/${m.id}`).expect(404);
    expect((await t.alice.get(`/api/tasks/${tk.id}`)).body).toMatchObject({ title: "Prep", meeting_count: 0 });
  });
});

describe("privacy and roles", () => {
  it("keeps private meetings private", async () => {
    const m = await meeting(t.carol, { title: "Doctor", starts_at: at(1) });
    for (const other of [t.alice, t.bob, t.dave, t.erin]) {
      await other.get(`/api/meetings/${m.id}`).expect(404);
      await other.patch(`/api/meetings/${m.id}`).send({ title: "x" }).expect(404);
      await other.delete(`/api/meetings/${m.id}`).expect(404);
      expect((await other.get("/api/meetings")).body).toEqual([]);
    }
  });

  it("shares workspace meetings with members, by role", async () => {
    const m = await meeting(t.carol, { title: "Sprint planning", starts_at: at(1), workspace_id: t.ws });
    expect(m.workspace_id).toBe(t.ws);
    for (const who of [t.alice, t.bob, t.dave]) expect(((await who.get("/api/meetings")).body as Json[]).map((x) => x.title)).toEqual(["Sprint planning"]);
    await t.erin.get(`/api/meetings/${m.id}`).expect(404);
    expect((await t.erin.get("/api/meetings")).body).toEqual([]);

    const see = async (a: Agent) => (await a.get(`/api/meetings/${m.id}`)).body;
    expect(await see(t.alice)).toMatchObject({ access: "admin", can_delete: true });
    expect(await see(t.carol)).toMatchObject({ access: "write", can_delete: true });
    expect(await see(t.dave)).toMatchObject({ access: "read", can_delete: false });

    // viewers read; they can't create or change anything
    await meeting(t.dave, { title: "no", starts_at: at(1), workspace_id: t.ws }, 403);
    await t.dave.patch(`/api/meetings/${m.id}`).send({ title: "no" }).expect(403);
    await t.dave.delete(`/api/meetings/${m.id}`).expect(403);
    // outsiders can't create in it either
    await meeting(t.erin, { title: "no", starts_at: at(1), workspace_id: t.ws }, 404);
    // members edit anyone's; delete only their own; admins delete any
    await t.bob.patch(`/api/meetings/${m.id}`).send({ location: "Room 2" }).expect(200);
    const byAlice = await meeting(t.alice, { title: "Alice's", starts_at: at(2), workspace_id: t.ws });
    await t.carol.patch(`/api/meetings/${byAlice.id}`).send({ location: "x" }).expect(200);
    await t.carol.delete(`/api/meetings/${byAlice.id}`).expect(403);
    await t.bob.delete(`/api/meetings/${byAlice.id}`).expect(204);
  });

  it("rejects garbage ids without a server error", async () => {
    await t.alice.get("/api/meetings/abc").expect(404);
    await t.alice.get("/api/meetings/99999999").expect(404);
    await t.alice.delete("/api/meetings/1;DROP").expect(404);
  });
});

describe("linking meetings to tasks", () => {
  it("links and unlinks, from either side, idempotently", async () => {
    const a = await task(t.alice, { title: "Prepare slides" });
    const b = await task(t.alice, { title: "Send agenda" });
    const m = await meeting(t.alice, { title: "Review", starts_at: at(1), task_ids: [a.id] });
    expect(m.task_ids).toEqual([a.id]);

    expect((await t.alice.post(`/api/meetings/${m.id}/tasks`).send({ task_id: b.id }).expect(201)).body.task_ids).toEqual([a.id, b.id]);
    await t.alice.post(`/api/meetings/${m.id}/tasks`).send({ task_id: b.id }).expect(201); // already linked: still fine, no duplicate
    expect((await t.alice.get(`/api/meetings/${m.id}`)).body.task_ids).toEqual([a.id, b.id]);

    // one meeting can serve several tasks, and a task can have several meetings
    const m2 = await meeting(t.alice, { title: "Follow-up", starts_at: at(5), task_ids: [a.id] });
    const fromTask = (await t.alice.get(`/api/tasks/${a.id}/meetings`)).body as Json[];
    expect(fromTask.map((x) => x.title)).toEqual(["Review", "Follow-up"]);
    expect(fromTask[0].task_ids).toEqual([a.id, b.id]);
    expect((await t.alice.get(`/api/tasks/${a.id}`)).body.meeting_count).toBe(2);
    expect((await t.alice.get(`/api/tasks/${b.id}`)).body.meeting_count).toBe(1);

    const after = (await t.alice.delete(`/api/meetings/${m.id}/tasks/${b.id}`).expect(200)).body;
    expect(after.task_ids).toEqual([a.id]);
    await t.alice.delete(`/api/meetings/${m.id}/tasks/${b.id}`).expect(200); // already unlinked: still fine
    expect((await t.alice.get(`/api/tasks/${b.id}`)).body.meeting_count).toBe(0);
    expect(m2.id).toBeGreaterThan(m.id);
  });

  it("creating with an invalid task link creates nothing", async () => {
    const mine = await task(t.alice, { title: "mine" });
    const bobs = await task(t.bob, { title: "bob private" });
    await meeting(t.alice, { title: "x", starts_at: at(1), task_ids: [mine.id, bobs.id] }, 400); // can't see Bob's private task
    await meeting(t.alice, { title: "x", starts_at: at(1), task_ids: [mine.id, 424242] }, 400);
    expect((await t.alice.get("/api/meetings")).body).toEqual([]); // the valid half was not left behind
  });

  it("requires the task and the meeting to be in the same place", async () => {
    const privateTask = await task(t.carol, { title: "private" });
    const sharedTask = await task(t.carol, { title: "shared", project_id: t.project });
    const privateMeeting = await meeting(t.carol, { title: "mine", starts_at: at(1) });
    const sharedMeeting = await meeting(t.carol, { title: "team", starts_at: at(1), workspace_id: t.ws });

    await t.carol.post(`/api/meetings/${privateMeeting.id}/tasks`).send({ task_id: sharedTask.id }).expect(400);
    await t.carol.post(`/api/meetings/${sharedMeeting.id}/tasks`).send({ task_id: privateTask.id }).expect(400);
    await meeting(t.carol, { title: "x", starts_at: at(1), workspace_id: t.ws, task_ids: [privateTask.id] }, 400);
    await t.carol.post(`/api/meetings/${sharedMeeting.id}/tasks`).send({ task_id: sharedTask.id }).expect(201);
    await t.carol.post(`/api/meetings/${privateMeeting.id}/tasks`).send({ task_id: privateTask.id }).expect(201);
  });

  it("requires permission on both ends", async () => {
    const shared = await task(t.alice, { title: "shared", project_id: t.project });
    const m = await meeting(t.alice, { title: "team", starts_at: at(1), workspace_id: t.ws });
    await t.dave.post(`/api/meetings/${m.id}/tasks`).send({ task_id: shared.id }).expect(403); // viewer
    await t.erin.post(`/api/meetings/${m.id}/tasks`).send({ task_id: shared.id }).expect(404); // outsider
    await t.carol.post(`/api/meetings/${m.id}/tasks`).send({ task_id: shared.id }).expect(201); // member
    await t.dave.delete(`/api/meetings/${m.id}/tasks/${shared.id}`).expect(403);
    // viewers can still see what's linked
    expect((await t.dave.get(`/api/tasks/${shared.id}/meetings`)).body).toHaveLength(1);
    await t.erin.get(`/api/tasks/${shared.id}/meetings`).expect(404);
  });

  it("drops links when a task is deleted, or moves between private and shared", async () => {
    const a = await task(t.carol, { title: "will be deleted" });
    const b = await task(t.carol, { title: "will be shared" });
    const m = await meeting(t.carol, { title: "m", starts_at: at(1), task_ids: [a.id, b.id] });
    await t.carol.delete(`/api/tasks/${a.id}`).expect(204);
    expect((await t.carol.get(`/api/meetings/${m.id}`)).body.task_ids).toEqual([b.id]);
    await t.carol.patch(`/api/tasks/${b.id}`).send({ project_id: t.project }).expect(200); // now shared; the private meeting can't follow
    expect((await t.carol.get(`/api/meetings/${m.id}`)).body.task_ids).toEqual([]);
    expect((await t.carol.get(`/api/tasks/${b.id}`)).body.meeting_count).toBe(0);
  });

  it("goes with the workspace, but survives a member leaving", async () => {
    const m = await meeting(t.carol, { title: "team", starts_at: at(1), workspace_id: t.ws });
    await t.alice.delete(`/api/workspaces/${t.ws}/members/${(await t.carol.get("/api/auth/me")).body.id}`).expect(204);
    expect((await t.alice.get(`/api/meetings/${m.id}`)).status).toBe(200); // shared work stays with the workspace
    await t.carol.get(`/api/meetings/${m.id}`).expect(404);
    await t.alice.delete(`/api/workspaces/${t.ws}`).expect(204);
    expect(await t.db.get("SELECT COUNT(*) AS n FROM meetings")).toEqual({ n: 0 });
    expect(await t.db.get("SELECT COUNT(*) AS n FROM meeting_tasks")).toEqual({ n: 0 });
  });
});

describe("listing", () => {
  it("filters by time, task and workspace, and orders by start", async () => {
    const tk = await task(t.alice, { title: "T" });
    await meeting(t.alice, { title: "past", starts_at: at(-30), ends_at: at(-29) });
    const soon = await meeting(t.alice, { title: "soon", starts_at: at(2), task_ids: [tk.id] });
    await meeting(t.alice, { title: "later", starts_at: at(48) });
    await meeting(t.alice, { title: "team", starts_at: at(3), workspace_id: t.ws });
    const titles = async (q: string) => ((await t.alice.get(`/api/meetings${q}`)).body as Json[]).map((m) => m.title);

    expect(await titles("")).toEqual(["past", "soon", "team", "later"]);
    expect(await titles("?sort=desc")).toEqual(["later", "team", "soon", "past"]);
    expect(await titles("?when=upcoming")).toEqual(["soon", "team", "later"]);
    expect(await titles("?when=past")).toEqual(["past"]);
    expect(await titles(`?task_id=${tk.id}`)).toEqual(["soon"]);
    expect(await titles(`?workspace_id=${t.ws}`)).toEqual(["team"]);
    expect(await titles(`?from=${encodeURIComponent(at(1))}&to=${encodeURIComponent(at(10))}`)).toEqual(["soon", "team"]);
    await t.alice.get("/api/meetings?when=never").expect(400);
    expect(soon.task_ids).toEqual([tk.id]);
  });
});

describe("activity and export", () => {
  it("records shared meetings in the workspace feed, and nothing for private ones", async () => {
    const shared = await task(t.carol, { title: "Agenda", project_id: t.project });
    const m = await meeting(t.carol, { title: "Planning", starts_at: at(1), workspace_id: t.ws, task_ids: [shared.id] });
    await t.carol.delete(`/api/meetings/${m.id}/tasks/${shared.id}`).expect(200);
    await t.carol.delete(`/api/meetings/${m.id}`).expect(204);
    await meeting(t.carol, { title: "Private", starts_at: at(1) });

    const kinds = ((await t.alice.get(`/api/workspaces/${t.ws}/activity?limit=100`)).body.items as Json[]).map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(["meeting_deleted", "meeting_unlinked", "meeting_linked", "meeting_created"]);
    const taskHistory = (await t.alice.get(`/api/tasks/${shared.id}/activity`)).body as Json[];
    expect(taskHistory.find((e) => e.kind === "meeting_linked")).toMatchObject({ detail: { title: "Planning", task_title: "Agenda" } });
    expect(JSON.stringify((await t.alice.get(`/api/workspaces/${t.ws}/activity?limit=100`)).body)).not.toContain("Private");
  });
});
