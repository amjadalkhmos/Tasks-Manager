import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import type { DB } from "./db.js";
import { parseAddress, rateLimiter, stripQuoted } from "./intake.js";
import { seedProjectStatuses } from "./statuses.js";
import { testDb } from "./test-db.js";

process.env.BCRYPT_ROUNDS = "4";

type Agent = ReturnType<typeof request.agent>;
type Json = Record<string, any>;

interface Team {
  db: DB;
  app: ReturnType<typeof createApp>;
  alice: Agent; // owner
  bob: Agent; // admin
  carol: Agent; // member
  dave: Agent; // viewer
  erin: Agent; // outsider
  ids: Record<string, number>;
  ws: number;
}

async function makeTeam(): Promise<Team> {
  const db = await testDb();
  const app = createApp(db, "s");
  const ids: Record<string, number> = {};
  const signup = async (name: string) => {
    const agent = request.agent(app);
    ids[name] = (await agent.post("/api/auth/register").send({ email: `${name}@example.com`, password: "password123", name }).expect(201)).body.id;
    return agent;
  };
  const [alice, bob, carol, dave, erin] = await Promise.all(["alice", "bob", "carol", "dave", "erin"].map(signup));
  const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  for (const [agent, email, role] of [[bob, "bob", "admin"], [carol, "carol", "member"], [dave, "dave", "viewer"]] as const) {
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: `${email}@example.com`, role }).expect(201);
    const invite = ((await agent.get("/api/invites")).body as Json[])[0];
    await agent.post(`/api/invites/${invite.id}/accept`).expect(200);
  }
  return { db, app, alice, bob, carol, dave, erin, ids, ws };
}

const create = (a: Agent, body: object, status = 201) => a.post("/api/projects").send(body).expect(status).then((r) => r.body as Json);
const task = async (a: Agent, body: object, status = 201) => (await a.post("/api/tasks").send(body).expect(status)).body as Json;
const getTask = async (a: Agent, id: number) => (await a.get(`/api/tasks/${id}`).expect(200)).body as Json;
const overview = async (a: Agent, id: number) => (await a.get(`/api/projects/${id}/overview`).expect(200)).body as Json;

/** Sales pipelines now live under Sales and can't be created as projects; this makes the old kind, as an existing database still holds. */
async function legacyPipeline(a: Agent, name: string) {
  const p = (await a.post("/api/projects").send({ name, workspace_id: t.ws }).expect(201)).body as Json;
  await t.db.run("UPDATE projects SET type = 'pipeline' WHERE id = ?", p.id);
  await seedProjectStatuses(t.db, p.id, "pipeline");
  return { ...p, type: "pipeline" } as Json;
}

let t: Team;
let desk: number;
beforeEach(async () => {
  t = await makeTeam();
  desk = (await create(t.alice, { name: "Help desk", workspace_id: t.ws, type: "support" })).id;
});

/** Opens the desk to the public and returns its link token. */
const open = async (a: Agent = t.alice, project = desk) => ((await a.post(`/api/projects/${project}/intake`).send({ enabled: true }).expect(200)).body as Json).token as string;
const publicApi = (token: string) => request(t.app).post(`/api/public/support/${token}`);
const form = (over: object = {}) => ({ name: "Jane Customer", email: "jane@customer.test", subject: "Cannot log in", message: "I get an error when I sign in.", ...over });

describe("support ticket numbers and clocks", () => {
  it("numbers tickets per support project, and leaves other work unnumbered", async () => {
    const a = await task(t.carol, { title: "First", project_id: desk });
    const b = await task(t.carol, { title: "Second", project_id: desk });
    expect([a.ticket_no, b.ticket_no]).toEqual([1, 2]);
    const plain = (await create(t.alice, { name: "Plain", workspace_id: t.ws })).id;
    expect((await task(t.carol, { title: "Work", project_id: plain })).ticket_no).toBeNull();
    const sub = await task(t.carol, { title: "Sub", parent_id: a.id });
    expect(sub.ticket_no).toBeNull(); // a subtask is part of its ticket
  });

  it("numbers a task that moves into a support project, and un-numbers one that leaves", async () => {
    const plain = (await create(t.alice, { name: "Plain", workspace_id: t.ws })).id;
    const a = await task(t.carol, { title: "Moves in", project_id: plain });
    expect((await t.carol.patch(`/api/tasks/${a.id}`).send({ project_id: desk }).expect(200)).body.ticket_no).toBe(1);
    expect((await t.carol.patch(`/api/tasks/${a.id}`).send({ project_id: plain }).expect(200)).body.ticket_no).toBeNull();
  });

  it("keeps requester details and refuses a bad email", async () => {
    const a = await task(t.carol, { title: "Phone call", project_id: desk, requester_name: "Sam", requester_email: "sam@customer.test" });
    expect(a).toMatchObject({ requester_name: "Sam", requester_email: "sam@customer.test", source: "internal" });
    await task(t.carol, { title: "Bad", project_id: desk, requester_email: "not-an-email" }, 400);
  });

  it("starts no clock until the project has service targets, then shows both", async () => {
    const a = await task(t.carol, { title: "Slow", project_id: desk });
    expect(a.sla).toBeNull();
    await t.alice.patch(`/api/projects/${desk}`).send({ first_response_hours: 4, resolution_hours: 48 }).expect(200);
    const b = await getTask(t.carol, a.id);
    expect(b.sla.response.state).toBe("pending");
    expect(b.sla.resolution.state).toBe("pending");
    expect(Date.parse(b.sla.resolution.due) - Date.parse(b.sla.response.due)).toBe(44 * 3_600_000);
    await t.alice.patch(`/api/projects/${desk}`).send({ first_response_hours: 0 }).expect(400);
    await t.carol.patch(`/api/projects/${desk}`).send({ resolution_hours: 8 }).expect(403);
    await t.alice.patch(`/api/projects/${desk}`).send({ currency: "usd" }).expect(400);
  });

  it("breaches a response clock that ran out, and stops it once someone responds", async () => {
    await t.alice.patch(`/api/projects/${desk}`).send({ first_response_hours: 1 }).expect(200);
    const a = await task(t.carol, { title: "Old", project_id: desk });
    await t.db.run("UPDATE tasks SET created_at = '2020-01-01 00:00:00' WHERE id = ?", a.id);
    expect((await getTask(t.carol, a.id)).sla.response.state).toBe("breached");
    expect((await overview(t.carol, desk)).support).toMatchObject({ open: 1, unanswered: 1, response_breached: 1 });
    const answered = (await t.carol.post(`/api/tasks/${a.id}/respond`).expect(200)).body as Json;
    expect(answered.first_response_at).toBeTruthy();
    expect(answered.sla.response.state).toBe("late"); // answered, but after the deadline
    const first = answered.first_response_at;
    expect(((await t.carol.post(`/api/tasks/${a.id}/respond`).expect(200)).body as Json).first_response_at).toBe(first); // only the first counts
    await t.dave.post(`/api/tasks/${a.id}/respond`).expect(403);
  });

  it("counts picking a ticket up, or finishing it, as the first response", async () => {
    const a = await task(t.carol, { title: "Picked up", project_id: desk });
    const doing = (await t.carol.patch(`/api/tasks/${a.id}`).send({ status: "doing" }).expect(200)).body as Json;
    expect(doing.first_response_at).toBeTruthy();
    const b = await task(t.carol, { title: "Quick fix", project_id: desk });
    const done = (await t.carol.post(`/api/tasks/${b.id}/complete`).expect(200)).body.completed as Json;
    expect(done.first_response_at).toBeTruthy();
    const plain = (await create(t.alice, { name: "Plain", workspace_id: t.ws })).id;
    const c = await task(t.carol, { title: "Not a ticket", project_id: plain });
    expect(((await t.carol.post(`/api/tasks/${c.id}/complete`).expect(200)).body.completed as Json).first_response_at).toBeNull();
    await t.carol.post(`/api/tasks/${c.id}/respond`).expect(409);
  });

  it("measures how quickly the desk answers and resolves", async () => {
    const a = await task(t.carol, { title: "A", project_id: desk });
    await t.db.run("UPDATE tasks SET created_at = '2026-03-01 08:00:00', first_response_at = '2026-03-01T09:00:00.000Z' WHERE id = ?", a.id);
    await t.carol.post(`/api/tasks/${a.id}/complete`).expect(200);
    await t.db.run("UPDATE tasks SET completed_at = '2026-03-01T12:00:00.000Z' WHERE id = ?", a.id);
    const s = (await overview(t.carol, desk)).support as Json;
    expect(s).toMatchObject({ open: 0, avg_first_response_min: 60, avg_resolution_min: 240 });
    expect(await t.carol.get(`/api/projects/${desk}/overview`).then((r) => r.body.intake)).toBeNull(); // members never see the link
  });
});

describe("the public support form", () => {
  it("is closed until the desk is opened, and only for support projects", async () => {
    await request(t.app).get("/api/public/support/abcdefghijklmnopqrstuvwx").expect(404);
    const plain = (await create(t.alice, { name: "Plain", workspace_id: t.ws })).id;
    await t.alice.post(`/api/projects/${plain}/intake`).send({ enabled: true }).expect(400);
    const token = await open();
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await request(t.app).get(`/api/public/support/${token}`).expect(200)).body).toEqual({ name: "Help desk" }); // nothing else is revealed
  });

  it("lets anyone submit a ticket without signing in", async () => {
    const token = await open();
    const res = await publicApi(token).send(form()).expect(201);
    expect(res.body).toEqual({ ticket_no: 1 });
    const list = (await t.carol.get(`/api/tasks?project_id=${desk}`).expect(200)).body as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: "Cannot log in", notes: "I get an error when I sign in.", requester_name: "Jane Customer", requester_email: "jane@customer.test",
      source: "form", ticket_no: 1, status: "todo",
    });
    expect((await publicApi(token).send(form({ subject: "Second" })).expect(201)).body.ticket_no).toBe(2);
  });

  it("checks the form and ignores bots", async () => {
    const token = await open();
    await publicApi(token).send(form({ email: "nope" })).expect(400);
    await publicApi(token).send(form({ name: "" })).expect(400);
    await publicApi(token).send(form({ subject: "x".repeat(201) })).expect(400);
    await publicApi(token).send(form({ message: "x".repeat(5001) })).expect(400);
    const bot = await publicApi(token).send(form({ website: "http://spam.test" })).expect(201);
    expect(bot.body).toEqual({ ticket_no: null });
    expect((await t.carol.get(`/api/tasks?project_id=${desk}`)).body).toEqual([]); // nothing was kept
  });

  it("stores what visitors write as plain text", async () => {
    const token = await open();
    await publicApi(token).send(form({ subject: "<script>alert(1)</script>" })).expect(201);
    expect(((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[])[0].title).toBe("<script>alert(1)</script>");
  });

  it("puts the ticket in the desk's first status, and tells the team", async () => {
    await t.alice.post("/api/statuses").send({ project_id: desk, name: "Inbox", category: "todo" }).expect(201);
    const token = await open();
    await publicApi(token).send(form()).expect(201);
    const ticket = ((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[])[0];
    const statuses = (await t.carol.get("/api/statuses")).body as Json[];
    expect(statuses.find((s) => s.id === ticket.status_id)?.name).toBe("New"); // the support preset's first status
    const alerts = (await t.bob.get("/api/alerts").expect(200)).body as Json;
    expect(JSON.stringify(alerts)).toContain("#1 Cannot log in"); // admins hear about it when no lead is set
    expect(JSON.stringify((await t.erin.get("/api/alerts")).body)).not.toContain("Cannot log in");
  });

  it("tells the lead, and only the lead, when there is one", async () => {
    await t.alice.patch(`/api/projects/${desk}`).send({ lead_id: t.ids.carol }).expect(200);
    const token = await open();
    await publicApi(token).send(form()).expect(201);
    expect(JSON.stringify((await t.carol.get("/api/alerts")).body)).toContain("Cannot log in");
    expect(JSON.stringify((await t.bob.get("/api/alerts")).body)).not.toContain("Cannot log in");
  });

  it("stops accepting tickets when switched off, rotated away, or the project is archived", async () => {
    const token = await open();
    await publicApi(token).send(form()).expect(201);
    const rotated = ((await t.alice.post(`/api/projects/${desk}/intake`).send({ enabled: true, rotate: true }).expect(200)).body as Json).token;
    expect(rotated).not.toBe(token);
    await publicApi(token).send(form()).expect(404); // the old link is dead
    await publicApi(rotated).send(form()).expect(201);
    expect(((await t.alice.post(`/api/projects/${desk}/intake`).send({ enabled: true }).expect(200)).body as Json).token).toBe(rotated); // enabling again keeps it
    await t.alice.post(`/api/projects/${desk}/stage`).send({ stage: "archived" }).expect(200);
    await publicApi(rotated).send(form()).expect(410);
    await t.alice.post(`/api/projects/${desk}/stage`).send({ stage: "active" }).expect(200);
    await t.alice.post(`/api/projects/${desk}/intake`).send({ enabled: false }).expect(200);
    await publicApi(rotated).send(form()).expect(404);
  });

  it("limits who can manage the link, and who can see it", async () => {
    await t.carol.post(`/api/projects/${desk}/intake`).send({ enabled: true }).expect(403);
    await t.erin.post(`/api/projects/${desk}/intake`).send({ enabled: true }).expect(404);
    const token = await open(t.bob);
    expect((await overview(t.bob, desk)).intake).toEqual({ enabled: true, token });
    expect((await overview(t.carol, desk)).intake).toBeNull();
    expect(JSON.stringify(await overview(t.carol, desk))).not.toContain(token);
  });

  it("slows down a visitor who submits too much", async () => {
    const token = await open();
    for (let i = 0; i < 5; i++) await publicApi(token).send(form({ subject: `Ticket ${i}` })).expect(201);
    await publicApi(token).send(form({ subject: "One too many" })).expect(429);
  });

  it("ignores malformed links without touching the database", async () => {
    await request(t.app).get("/api/public/support/short").expect(404);
    await request(t.app).post("/api/public/support/'; DROP TABLE tasks;--").send(form()).expect(404);
    expect((await t.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks"))!.n).toBe(0);
  });
});

describe("inbound email", () => {
  const mail = (token: string) => request(t.app).post(`/api/intake/email/${token}`);

  it("turns an email into a ticket", async () => {
    const token = await open();
    const res = await mail(token).send({ from: "Jane Customer <Jane@Customer.test>", subject: "Printer broken", text: "It is on fire.\n\nOn Mon, Bob wrote:\n> hello" }).expect(201);
    expect(res.body).toEqual({ ticket_no: 1, reply: false });
    const ticket = ((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[])[0];
    expect(ticket).toMatchObject({ title: "Printer broken", notes: "It is on fire.", requester_name: "Jane Customer", requester_email: "jane@customer.test", source: "email" });
  });

  it("understands form-encoded (Mailgun style) and Postmark messages", async () => {
    const token = await open();
    await mail(token).type("form").send({ sender: "Sam <sam@customer.test>", subject: "Hello", "body-plain": "Need help" }).expect(201);
    await mail(token).send({ FromFull: { Email: "kim@customer.test", Name: "Kim" }, Subject: "Hi", TextBody: "Please call" }).expect(201);
    const tickets = (await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[];
    expect(tickets.map((x) => [x.requester_name, x.title, x.notes]).sort()).toEqual([["Kim", "Hi", "Please call"], ["Sam", "Hello", "Need help"]]);
  });

  it("adds a customer's reply to their ticket and reopens it if it was finished", async () => {
    const token = await open();
    await mail(token).send({ from: "jane@customer.test", subject: "Problem", text: "Broken" }).expect(201);
    const ticket = ((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[])[0];
    await t.carol.post(`/api/tasks/${ticket.id}/complete`).expect(200);
    const reply = await mail(token).send({ from: "Jane <jane@customer.test>", subject: "Re: Problem [#1]", text: "Still broken.\n\nOn Tue, Carol wrote:\n> try again" }).expect(201);
    expect(reply.body).toEqual({ ticket_no: 1, reply: true });
    const after = await getTask(t.carol, ticket.id);
    expect(after).toMatchObject({ status: "todo", completed_at: null });
    const comments = (await t.carol.get(`/api/tasks/${ticket.id}/comments`)).body as Json[];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ body: "Still broken.", requester: "Jane" });
    expect(((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[])).toHaveLength(1); // no second ticket
  });

  it("won't let someone else's email join a ticket", async () => {
    const token = await open();
    await mail(token).send({ from: "jane@customer.test", subject: "Mine", text: "Hello" }).expect(201);
    const res = await mail(token).send({ from: "mallory@evil.test", subject: "Re: Mine [#1]", text: "Injected" }).expect(201);
    expect(res.body).toEqual({ ticket_no: 2, reply: false }); // becomes a ticket of their own
    expect(((await t.carol.get(`/api/tasks/${((await t.carol.get(`/api/tasks?project_id=${desk}`)).body as Json[]).find((x) => x.ticket_no === 1)!.id}/comments`)).body as Json[])).toEqual([]);
  });

  it("ignores robots and empty messages, but acknowledges them", async () => {
    const token = await open();
    await mail(token).send({ from: "Mail Delivery <mailer-daemon@mail.test>", subject: "Undeliverable", text: "bounce" }).expect(202);
    await mail(token).send({ from: "jane@customer.test", subject: "Blank", text: "   " }).expect(202);
    await mail(token).send({ from: "not an address", subject: "?", text: "x" }).expect(202);
    expect((await t.carol.get(`/api/tasks?project_id=${desk}`)).body).toEqual([]);
  });

  it("is closed to anyone without the secret address", async () => {
    await mail("wrongwrongwrongwrongwrong").send({ from: "jane@customer.test", subject: "x", text: "y" }).expect(404);
  });
});

describe("email helpers", () => {
  it("reads addresses in the usual shapes", () => {
    expect(parseAddress('"Doe, Jane" <JANE@x.test>')).toEqual({ name: "Doe, Jane", email: "jane@x.test" });
    expect(parseAddress("jane@x.test")).toEqual({ name: "jane", email: "jane@x.test" });
    expect(parseAddress("<jane@x.test>")).toEqual({ name: "jane", email: "jane@x.test" });
    expect(parseAddress("nonsense")).toBeNull();
  });

  it("keeps new words and drops the quoted history", () => {
    expect(stripQuoted("Thanks!\n\nOn Tue, 3 Mar 2026, Bob <b@x.test> wrote:\n> old stuff")).toBe("Thanks!");
    expect(stripQuoted("Line one\nLine two\n> quoted\n> more")).toBe("Line one\nLine two");
    expect(stripQuoted("Hi\n-----Original Message-----\nFrom: x")).toBe("Hi");
    expect(stripQuoted("> only a quote")).toBe("> only a quote"); // never returns nothing
  });

  it("limits hits per window", () => {
    const limit = rateLimiter(2, 1000);
    expect([limit("a", 0), limit("a", 1), limit("a", 2), limit("b", 2), limit("a", 1500)]).toEqual([true, true, false, true, true]);
  });
});

describe("sales pipeline", () => {
  let leads: number;
  const stage = async (name: string) => ((await t.carol.get("/api/statuses")).body as Json[]).find((s) => s.project_id === leads && s.name === name)!;
  beforeEach(async () => {
    leads = (await legacyPipeline(t.alice, "Leads")).id;
  });

  it("starts each stage with a chance of winning, which managers can change", async () => {
    const stages = ((await t.carol.get("/api/statuses")).body as Json[]).filter((s) => s.project_id === leads);
    expect(stages.map((s) => [s.name, s.probability])).toEqual([["New", 10], ["Contacted", 25], ["Qualified", 60], ["Won", 100], ["Lost", 0]]);
    const q = await stage("Qualified");
    expect(((await t.alice.patch(`/api/statuses/${q.id}`).send({ probability: 75 }).expect(200)).body as Json).probability).toBe(75);
    expect(((await t.alice.patch(`/api/statuses/${q.id}`).send({ probability: null }).expect(200)).body as Json).probability).toBeNull();
    await t.alice.patch(`/api/statuses/${q.id}`).send({ probability: 101 }).expect(400);
    await t.carol.patch(`/api/statuses/${q.id}`).send({ probability: 50 }).expect(403);
  });

  it("keeps a deal's value, and refuses a negative one", async () => {
    const d = await task(t.carol, { title: "Acme Ltd", project_id: leads, value: 12500.5 });
    expect(d.value).toBe(12500.5);
    expect(((await t.carol.patch(`/api/tasks/${d.id}`).send({ value: null }).expect(200)).body as Json).value).toBeNull();
    await task(t.carol, { title: "Bad", project_id: leads, value: -1 }, 400);
    await t.carol.patch("/api/projects/" + leads).send({ currency: "EUR" }).expect(403);
    await t.alice.patch(`/api/projects/${leads}`).send({ currency: "EUR" }).expect(200);
    expect((await overview(t.carol, leads)).pipeline.currency).toBe("EUR");
  });

  it("forecasts open deals by stage, and reports won and lost", async () => {
    const [contacted, qualified, won, lost] = await Promise.all(["Contacted", "Qualified", "Won", "Lost"].map(stage));
    await task(t.carol, { title: "A", project_id: leads, value: 1000 }); // New: 10%
    await task(t.carol, { title: "B", project_id: leads, value: 2000, status_id: contacted.id }); // 25%
    await task(t.carol, { title: "C", project_id: leads, value: 4000, status_id: qualified.id, due_at: "2026-07-15T00:00:00.000Z" }); // 60%
    const w = await task(t.carol, { title: "W", project_id: leads, value: 9000 });
    const l = await task(t.carol, { title: "L", project_id: leads, value: 3000 });
    await t.carol.post(`/api/tasks/${w.id}/complete`).send({ status_id: won.id }).expect(200);
    await t.carol.post(`/api/tasks/${l.id}/complete`).send({ status_id: lost.id }).expect(200);

    const f = (await overview(t.carol, leads)).pipeline as Json;
    expect(f).toMatchObject({
      open_count: 3, open_value: 7000, weighted_value: 100 + 500 + 2400, won_count: 1, won_value: 9000, lost_count: 1, lost_value: 3000, win_rate: 50, avg_won_value: 9000,
    });
    expect(f.by_stage.find((s: Json) => s.name === "Qualified")).toMatchObject({ count: 1, value: 4000, weighted: 2400, probability: 60 });
    expect(f.by_month).toEqual([{ month: "2026-07", count: 1, value: 4000, weighted: 2400 }]);
    expect(f.no_close_date).toEqual({ count: 2, value: 3000 });
  });

  it("has no forecast on other kinds of project", async () => {
    expect((await overview(t.carol, desk)).pipeline).toBeNull();
    expect((await overview(t.carol, leads)).support).toBeNull();
  });
});
