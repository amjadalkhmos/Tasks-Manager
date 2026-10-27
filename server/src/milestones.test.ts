import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { createSchema } from "./db-schema.js";
import type { DB } from "./db.js";
import { testDb } from "./test-db.js";

process.env.BCRYPT_ROUNDS = "4";

type Agent = ReturnType<typeof request.agent>;
type Json = Record<string, any>;

interface Team {
  db: DB;
  alice: Agent; // owner
  bob: Agent; // admin
  carol: Agent; // member, and the project's lead
  dave: Agent; // viewer
  frank: Agent; // member, not the lead
  erin: Agent; // outsider
  ids: Record<string, number>;
  ws: number;
  project: number;
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
  const [alice, bob, carol, dave, frank, erin] = await Promise.all(["alice", "bob", "carol", "dave", "frank", "erin"].map(signup));
  const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  for (const [agent, email, role] of [[bob, "bob", "admin"], [carol, "carol", "member"], [dave, "dave", "viewer"], [frank, "frank", "member"]] as const) {
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: `${email}@example.com`, role }).expect(201);
    const invite = ((await agent.get("/api/invites")).body as Json[])[0];
    await agent.post(`/api/invites/${invite.id}/accept`).expect(200);
  }
  const project = (await alice.post("/api/projects").send({ name: "Launch", workspace_id: ws, type: "delivery", lead_id: ids.carol }).expect(201)).body.id as number;
  return { db, alice, bob, carol, dave, frank, erin, ids, ws, project };
}

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});

const body = async (r: request.Test, status = 200) => (await r.expect(status)).body as Json;
const make = (a: Agent, over: Json = {}, project = t.project, status = 201) => body(a.post(`/api/projects/${project}/milestones`).send({ name: "Beta", due_date: "2030-06-01", ...over }), status);
const overview = async (a: Agent = t.alice, project = t.project) => body(a.get(`/api/projects/${project}/overview`));
const standingOf = async (id: number, a: Agent = t.alice) => ((await overview(a)).milestones as Json[]).find((m) => m.id === id)!;
const task = (a: Agent, over: Json) => body(a.post("/api/tasks").send({ title: "Work", project_id: t.project, ...over }), 201);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("a milestone's details", () => {
  it("carries a description, acceptance criteria, an owner and a baseline of its own", async () => {
    const m = await make(t.carol, { description: "First public build", criteria: "Passes the smoke test", owner_id: t.ids.frank });
    expect(m).toMatchObject({ name: "Beta", due_date: "2030-06-01", baseline_date: "2030-06-01", description: "First public build", criteria: "Passes the smoke test", owner_id: t.ids.frank, owner_name: "frank", outcome: null, depends_on: [] });
    const o = await standingOf(m.id);
    expect(o).toMatchObject({ state: "upcoming", risks: [], slipped_days: 0, slips: 0, owner_name: "frank" });
    await make(t.carol, { owner_id: t.ids.erin }, t.project, 400); // not on the project
    await make(t.dave, {}, t.project, 403);
    await make(t.erin, {}, t.project, 404);
    await make(t.carol, { name: "" }, t.project, 400);
  });

  it("takes the first date it is given as the promise", async () => {
    const m = await make(t.carol, { due_date: null });
    expect(m.baseline_date).toBeNull();
    const dated = await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-07-01" }));
    expect(dated).toMatchObject({ due_date: "2030-07-01", baseline_date: "2030-07-01" });
  });

  it("only lets the lead or a manager change the baseline", async () => {
    const m = await make(t.carol);
    await t.frank.patch(`/api/milestones/${m.id}`).send({ baseline_date: "2030-05-01" }).expect(403);
    expect((await body(t.carol.patch(`/api/milestones/${m.id}`).send({ baseline_date: "2030-05-01" }))).baseline_date).toBe("2030-05-01"); // carol leads the project
    expect((await body(t.bob.patch(`/api/milestones/${m.id}`).send({ baseline_date: null }))).baseline_date).toBeNull();
  });

  it("shows its linked tasks, history and who waits on it", async () => {
    const m = await make(t.carol);
    const other = await make(t.carol, { name: "Launch" });
    await body(t.carol.patch(`/api/milestones/${other.id}`).send({ depends_on: [m.id] }));
    await task(t.carol, { title: "Build it", milestone_id: m.id });
    const d = await body(t.dave.get(`/api/milestones/${m.id}`));
    expect(d).toMatchObject({ name: "Beta", can_write: false, can_sign_off: false });
    expect(d.tasks.map((x: Json) => x.title)).toEqual(["Build it"]);
    expect(d.dependents).toEqual([{ id: other.id, name: "Launch" }]);
    expect(d.others.map((x: Json) => x.name)).toEqual(["Launch"]);
    expect((await body(t.carol.get(`/api/milestones/${m.id}`))).can_sign_off).toBe(true);
    await t.erin.get(`/api/milestones/${m.id}`).expect(404);
  });
});

describe("moving the forecast", () => {
  it("keeps every move with its reason, next to the baseline", async () => {
    const m = await make(t.carol, { due_date: "2030-06-01" });
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-06-10", reason: "Vendor delay" }));
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-06-20" }));
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ name: "Beta release" })); // not a move
    const d = await body(t.carol.get(`/api/milestones/${m.id}`));
    expect(d).toMatchObject({ due_date: "2030-06-20", baseline_date: "2030-06-01" });
    expect(d.moves.map((x: Json) => [x.from_date, x.to_date, x.reason, x.user_name])).toEqual([["2030-06-10", "2030-06-20", "", "carol"], ["2030-06-01", "2030-06-10", "Vendor delay", "carol"]]);
    expect(await standingOf(m.id)).toMatchObject({ slips: 2, slipped_days: 19 });
  });

  it("does not record a move when the date stays the same", async () => {
    const m = await make(t.carol);
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-06-01" }));
    expect((await body(t.carol.get(`/api/milestones/${m.id}`))).moves).toEqual([]);
  });
});

describe("what puts a milestone at risk", () => {
  it("is nothing while it is on its dates with its work on time", async () => {
    const m = await make(t.carol);
    await task(t.carol, { milestone_id: m.id, due_at: "2030-05-20T09:00:00.000Z" });
    expect(await standingOf(m.id)).toMatchObject({ state: "upcoming", risks: [] });
  });

  it("notices a forecast later than the baseline", async () => {
    const m = await make(t.carol);
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-06-08" }));
    const s = await standingOf(m.id);
    expect(s).toMatchObject({ state: "at_risk", slipped_days: 7 });
    expect(s.risks).toEqual(["The forecast is 7 days later than the baseline"]);
    // moving it earlier again clears the risk
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-05-30" }));
    expect(await standingOf(m.id)).toMatchObject({ state: "upcoming", slipped_days: 0 });
  });

  it("notices a date that passed without a decision", async () => {
    const m = await make(t.carol, { due_date: day(-3) });
    const s = await standingOf(m.id);
    expect(s).toMatchObject({ state: "at_risk", overdue: true });
    expect(s.risks[0]).toContain("hasn't been signed off");
  });

  it("notices work that is overdue or due after the date", async () => {
    const m = await make(t.carol, { due_date: day(30) });
    await task(t.carol, { milestone_id: m.id, due_at: `${day(40)}T09:00:00.000Z` });
    await task(t.carol, { milestone_id: m.id, due_at: `${day(-2)}T09:00:00.000Z` });
    const s = await standingOf(m.id);
    expect(s).toMatchObject({ state: "at_risk", tasks_late: 2 });
    expect(s.risks).toEqual(["2 tasks overdue or due after its date"]);
  });

  it("notices a prerequisite that is late, missed, or due after it", async () => {
    const first = await make(t.carol, { name: "First", due_date: "2030-06-10" });
    const second = await make(t.carol, { name: "Second", due_date: "2030-06-01", depends_on: [first.id] });
    expect((await standingOf(second.id)).risks).toEqual(["It depends on “First”, forecast after this date"]);
    await body(t.carol.patch(`/api/milestones/${second.id}`).send({ due_date: "2030-06-20" }));
    expect((await standingOf(second.id)).risks).toEqual(["The forecast is 19 days later than the baseline"]); // after it now, but slipped
    await body(t.carol.patch(`/api/milestones/${first.id}`).send({ due_date: "2030-06-15" }));
    await body(t.carol.post(`/api/milestones/${first.id}/sign-off`).send({ outcome: "missed", note: "Cut" }));
    expect((await standingOf(second.id)).risks).toContain("It depends on “First”, which was missed");
    await body(t.carol.post(`/api/milestones/${first.id}/reopen`));
    await body(t.carol.post(`/api/milestones/${first.id}/sign-off`).send({ outcome: "achieved" }));
    expect((await standingOf(second.id)).risks.some((r: string) => r.startsWith("It depends on"))).toBe(false);
  });

  it("feeds the project's health and signals", async () => {
    const m = await make(t.carol, { due_date: "2030-06-01" });
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-06-09" }));
    const o = await overview();
    expect(o.progress.signals.map((s: Json) => s.code)).toContain("milestone_slipping");
    expect(o.progress.milestones_at_risk).toBe(1);
  });
});

describe("deciding a milestone", () => {
  it("is for the project's lead or a manager, never another member or a viewer", async () => {
    const m = await make(t.carol);
    await t.frank.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }).expect(403);
    await t.dave.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }).expect(403);
    await t.erin.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }).expect(404);
    await t.carol.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "bogus" }).expect(400);
    const done = await body(t.carol.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved", note: "Verified by QA" }));
    expect(done).toMatchObject({ outcome: "achieved", sign_off_note: "Verified by QA", signed_off_by: t.ids.carol });
    expect(done.completed_at).toBeTruthy();
    expect(done.signed_off_at).toBeTruthy();
    expect(await standingOf(m.id)).toMatchObject({ state: "achieved", risks: [] });

    const other = await make(t.bob, { name: "Other" });
    expect((await body(t.bob.post(`/api/milestones/${other.id}/sign-off`).send({ outcome: "missed", note: "Dropped" }))).outcome).toBe("missed");
    expect((await body(t.bob.get(`/api/milestones/${other.id}`))).completed_at).toBeNull();
    expect(await standingOf(other.id)).toMatchObject({ state: "missed" });
    expect((await overview()).progress).toMatchObject({ milestones_done: 1, milestones_missed: 1, milestones_total: 2 });
  });

  it("lets the person who made a private project decide its milestones", async () => {
    const mine = (await t.frank.post("/api/projects").send({ name: "Private" }).expect(201)).body.id as number;
    const m = await make(t.frank, {}, mine);
    await body(t.frank.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }));
    expect((await overview(t.frank, mine)).access.can_sign_off).toBe(true);
  });

  it("tells each viewer whether they can decide", async () => {
    expect((await overview(t.carol)).access).toMatchObject({ can_sign_off: true });
    expect((await overview(t.bob)).access).toMatchObject({ can_sign_off: true });
    expect((await overview(t.frank)).access).toMatchObject({ can_sign_off: false });
    expect((await overview(t.dave)).access).toMatchObject({ can_sign_off: false });
  });

  it("is a single decision: no second one, no date changes, until it is reopened", async () => {
    const m = await make(t.carol);
    await body(t.carol.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }));
    await t.carol.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "missed" }).expect(409);
    await t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-08-01" }).expect(409);
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ description: "Still editable" }));
    await t.frank.post(`/api/milestones/${m.id}/reopen`).expect(403);
    const reopened = await body(t.carol.post(`/api/milestones/${m.id}/reopen`));
    expect(reopened).toMatchObject({ outcome: null, completed_at: null, signed_off_at: null, sign_off_note: "" });
    await t.carol.post(`/api/milestones/${m.id}/reopen`).expect(409);
    await body(t.carol.patch(`/api/milestones/${m.id}`).send({ due_date: "2030-08-01" }));
  });

  it("won't achieve a milestone before what it waits on, unless forced", async () => {
    const first = await make(t.carol, { name: "First" });
    const second = await make(t.carol, { name: "Second", depends_on: [first.id] });
    const refused = await body(t.carol.post(`/api/milestones/${second.id}/sign-off`).send({ outcome: "achieved" }), 409);
    expect(refused.error).toContain("“First”");
    await t.carol.post(`/api/milestones/${second.id}/sign-off`).send({ outcome: "missed" }).expect(200); // a miss is never blocked
    await body(t.carol.post(`/api/milestones/${second.id}/reopen`));
    await body(t.carol.post(`/api/milestones/${second.id}/sign-off`).send({ outcome: "achieved", force: true }));
    await body(t.carol.post(`/api/milestones/${second.id}/reopen`));
    await body(t.carol.post(`/api/milestones/${first.id}/sign-off`).send({ outcome: "achieved" }));
    await body(t.carol.post(`/api/milestones/${second.id}/sign-off`).send({ outcome: "achieved" }));
  });
});

describe("dependencies", () => {
  it("stay inside the project, and never loop", async () => {
    const a = await make(t.carol, { name: "A" });
    const b = await make(t.carol, { name: "B", depends_on: [a.id] });
    const c = await make(t.carol, { name: "C", depends_on: [b.id] });
    expect((await body(t.carol.get(`/api/milestones/${c.id}`))).depends_on).toEqual([b.id]);
    await t.carol.patch(`/api/milestones/${a.id}`).send({ depends_on: [c.id] }).expect(400); // A -> C -> B -> A
    await t.carol.patch(`/api/milestones/${a.id}`).send({ depends_on: [a.id] }).expect(400);
    const other = (await t.alice.post("/api/projects").send({ name: "Other", workspace_id: t.ws }).expect(201)).body.id as number;
    const foreign = await make(t.alice, { name: "Elsewhere" }, other);
    await t.carol.patch(`/api/milestones/${a.id}`).send({ depends_on: [foreign.id] }).expect(400);
    await t.carol.patch(`/api/milestones/${a.id}`).send({ depends_on: [999999] }).expect(400);
    await body(t.carol.patch(`/api/milestones/${c.id}`).send({ depends_on: [] }));
    expect((await body(t.carol.get(`/api/milestones/${c.id}`))).depends_on).toEqual([]);
    expect((await standingOf(b.id)).depends_on).toEqual([a.id]);
  });

  it("are dropped along with a deleted milestone", async () => {
    const a = await make(t.carol, { name: "A" });
    const b = await make(t.carol, { name: "B", depends_on: [a.id] });
    await t.carol.delete(`/api/milestones/${a.id}`).expect(204);
    expect((await body(t.carol.get(`/api/milestones/${b.id}`))).depends_on).toEqual([]);
  });
});

describe("payment and deliverable markers", () => {
  it("flag a milestone, with an amount for a payment", async () => {
    const pay = await make(t.carol, { name: "Phase 1", marker: "payment", amount: 5000 });
    expect(pay).toMatchObject({ marker: "payment", amount: 5000, invoiced_at: null });
    const deliverable = await make(t.carol, { name: "Handover", marker: "deliverable", amount: 999 });
    expect(deliverable).toMatchObject({ marker: "deliverable", amount: null }); // an amount only means something for a payment
    const changed = await body(t.carol.patch(`/api/milestones/${pay.id}`).send({ marker: "deliverable" }));
    expect(changed).toMatchObject({ marker: "deliverable", amount: null });
    await t.carol.patch(`/api/milestones/${pay.id}`).send({ marker: "invoice" }).expect(400);
    await t.carol.patch(`/api/milestones/${pay.id}`).send({ marker: "payment", amount: -1 }).expect(400);
  });

  it("are invoiced once achieved, by someone who can decide, and cleared on reopening", async () => {
    const m = await make(t.carol, { name: "Phase 1", marker: "payment", amount: 5000 });
    await t.carol.post(`/api/milestones/${m.id}/invoiced`).send({ invoiced: true }).expect(409); // not achieved yet
    await body(t.carol.post(`/api/milestones/${m.id}/sign-off`).send({ outcome: "achieved" }));
    await t.frank.post(`/api/milestones/${m.id}/invoiced`).send({ invoiced: true }).expect(403);
    expect((await body(t.carol.post(`/api/milestones/${m.id}/invoiced`).send({ invoiced: true }))).invoiced_at).toBeTruthy();
    expect((await standingOf(m.id)).invoiced_at).toBeTruthy();
    expect((await body(t.carol.post(`/api/milestones/${m.id}/invoiced`).send({ invoiced: false }))).invoiced_at).toBeNull();
    await body(t.carol.post(`/api/milestones/${m.id}/invoiced`).send({ invoiced: true }));
    expect((await body(t.carol.post(`/api/milestones/${m.id}/reopen`))).invoiced_at).toBeNull();
    const plain = await make(t.carol, { name: "Plain" });
    await body(t.carol.post(`/api/milestones/${plain.id}/sign-off`).send({ outcome: "achieved" }));
    await t.carol.post(`/api/milestones/${plain.id}/invoiced`).send({ invoiced: true }).expect(409);
  });
});

describe("milestones that existed before", () => {
  it("keep their date as the baseline and their done state as achieved", async () => {
    const m = await make(t.carol, { due_date: "2030-06-01" });
    const done = await make(t.carol, { name: "Finished", due_date: "2030-05-01" });
    // put both back the way the earlier version stored them
    await t.db.run("UPDATE milestones SET baseline_date = NULL, outcome = NULL, signed_off_at = NULL");
    await t.db.run("UPDATE milestones SET completed_at = ? WHERE id = ?", "2030-04-20T10:00:00.000Z", done.id);
    await createSchema(t.db);
    await createSchema(t.db); // safe to repeat
    expect(await standingOf(m.id)).toMatchObject({ baseline_date: "2030-06-01", due_date: "2030-06-01", state: "upcoming", slipped_days: 0 });
    expect(await standingOf(done.id)).toMatchObject({ baseline_date: "2030-05-01", outcome: "achieved", state: "achieved", completed_at: "2030-04-20T10:00:00.000Z" });
    expect((await overview()).progress).toMatchObject({ milestones_done: 1, milestones_total: 2 });
  });
});
