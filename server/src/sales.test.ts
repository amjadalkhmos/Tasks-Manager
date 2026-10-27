import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import type { DB } from "./db.js";
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
  frank: Agent; // member
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
  const [alice, bob, carol, dave, frank, erin] = await Promise.all(["alice", "bob", "carol", "dave", "frank", "erin"].map(signup));
  const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  for (const [agent, email, role] of [[bob, "bob", "admin"], [carol, "carol", "member"], [dave, "dave", "viewer"], [frank, "frank", "member"]] as const) {
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: `${email}@example.com`, role }).expect(201);
    const invite = ((await agent.get("/api/invites")).body as Json[])[0];
    await agent.post(`/api/invites/${invite.id}/accept`).expect(200);
  }
  return { db, app, alice, bob, carol, dave, frank, erin, ids, ws };
}

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});

const q = (o: Record<string, unknown> = {}) => ({ workspace_id: t.ws, ...o });
const grant = (who: string, body: Json = { enabled: true }, by: Agent = t.alice) => by.put(`/api/workspaces/${t.ws}/sales-access/${t.ids[who]}`).send(body);
const body = async (r: request.Test, status = 200) => (await r.expect(status)).body as Json;
const me = (a: Agent) => body(a.get("/api/sales/me").query(q()));
const pipeline = async (a: Agent = t.alice) => ((await me(a)).pipelines as Json[])[0];
const stageNamed = async (name: string) => ((await pipeline()).stages as Json[]).find((s) => s.name === name)!;
const lead = (a: Agent, over: Json = {}, status = 201) => body(a.post("/api/sales/leads").send(q({ name: "Jo Prospect", email: "jo@prospect.test", ...over })), status);
const account = (a: Agent, over: Json = {}, status = 201) => body(a.post("/api/sales/accounts").send(q({ name: "Prospect Ltd", ...over })), status);
const deal = async (a: Agent, over: Json = {}, status = 201) => {
  const accountId = over.account_id ?? (await account(a, { name: `Co ${Math.random()}`, website: "" })).id;
  return body(a.post("/api/sales/deals").send(q({ title: "Big deal", pipeline_id: (await pipeline()).id, account_id: accountId, value: 1000, ...over })), status);
};

describe("who can use Sales", () => {
  it("keeps it off for members until an admin switches it on, and always on for admins", async () => {
    expect(await body(t.carol.get("/api/sales/me").query(q()))).toEqual({ enabled: false });
    await t.carol.get("/api/sales/leads").query(q()).expect(403);
    await t.carol.post("/api/sales/accounts").send(q({ name: "X" })).expect(403);
    expect((await body(t.bob.get("/api/sales/me").query(q()))).manager).toBe(true);
    expect((await body(t.alice.get("/api/sales/me").query(q()))).manager).toBe(true);
    await t.erin.get("/api/sales/me").query(q()).expect(404);
    expect(await body(t.carol.get("/api/sales/workspaces"))).toEqual([]);
    await grant("carol");
    expect(await body(t.carol.get("/api/sales/workspaces"))).toEqual([{ id: t.ws, name: "Acme", manager: false }]);
    expect((await me(t.carol)).enabled).toBe(true);
  });

  it("lets only admins manage grants, and never for people who already see everything", async () => {
    await grant("frank", { enabled: true }, t.carol).expect(403);
    await grant("bob").expect(400);
    await grant("erin").expect(404);
    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.erin, level: "view" }] }).expect(400); // not a member
    await body(grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "view" }], unassigned: "view" }, t.bob));
    const rows = await body(t.alice.get(`/api/workspaces/${t.ws}/sales-access`));
    const carol = (rows as unknown as Json[]).find((r) => r.user_id === t.ids.carol)!;
    expect(carol).toMatchObject({ enabled: true, grants: [{ owner_id: t.ids.frank, level: "view" }], unassigned: "view", everything: false });
    await t.carol.get(`/api/workspaces/${t.ws}/sales-access`).expect(403);
    await body(grant("carol", { enabled: false }));
    expect((await me(t.carol)).enabled).toBe(false);
  });

  it("shows each person only the records of the owners they were given", async () => {
    await grant("carol");
    await grant("frank");
    const mine = await lead(t.carol, { name: "Carol's lead", email: "c@x.test" });
    const theirs = await lead(t.frank, { name: "Frank's lead", email: "f@x.test" });
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[]).map((l) => l.name)).toEqual(["Carol's lead"]);
    await t.carol.get(`/api/sales/leads/${theirs.id}`).expect(404);
    await t.carol.patch(`/api/sales/leads/${theirs.id}`).send({ notes: "x" }).expect(404);
    await t.carol.delete(`/api/sales/leads/${theirs.id}`).expect(404);

    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "view" }] });
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[]).length).toBe(2);
    expect((await body(t.carol.get(`/api/sales/leads/${theirs.id}`))).can_edit).toBe(false);
    await t.carol.patch(`/api/sales/leads/${theirs.id}`).send({ notes: "x" }).expect(403);
    await t.carol.post("/api/sales/activities").send({ lead_id: theirs.id, kind: "note", body: "hi" }).expect(403);

    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "edit" }] });
    await t.carol.patch(`/api/sales/leads/${theirs.id}`).send({ notes: "x" }).expect(200);
    // Frank still can't see Carol's.
    await t.frank.get(`/api/sales/leads/${mine.id}`).expect(404);
    // Admins see everything.
    expect(((await body(t.bob.get("/api/sales/leads").query(q()))) as unknown as Json[]).length).toBe(2);
  });

  it("caps a workspace viewer at viewing, whatever they were granted", async () => {
    await grant("carol");
    const l = await lead(t.carol);
    await grant("dave", { enabled: true, grants: [{ owner_id: t.ids.carol, level: "edit" }] });
    expect((await body(t.dave.get(`/api/sales/leads/${l.id}`))).can_edit).toBe(false);
    await t.dave.patch(`/api/sales/leads/${l.id}`).send({ notes: "x" }).expect(403);
    await t.dave.post("/api/sales/leads").send(q({ name: "Mine" })).expect(403);
  });

  it("only lets people hand records to owners they can edit", async () => {
    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "view" }] });
    await grant("frank");
    const l = await lead(t.carol);
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ owner_id: t.ids.frank }).expect(403); // view only
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ owner_id: null }).expect(403); // no unassigned access
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ owner_id: t.ids.erin }).expect(400); // not a member
    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "edit" }], unassigned: "edit" });
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ owner_id: t.ids.frank }).expect(200);
    await t.carol.get(`/api/sales/leads/${l.id}`).expect(200); // still hers to see: she can edit Frank's
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ owner_id: null }).expect(200);
    expect(((await body(t.frank.get("/api/sales/leads").query(q()))) as unknown as Json[]).length).toBe(0);
    await lead(t.carol, { owner_id: t.ids.bob }, 403); // can't create for someone she can't edit
  });

  it("returns members' records to the inbox when they leave", async () => {
    await grant("carol");
    const l = await lead(t.carol);
    const a = await account(t.carol);
    await t.alice.delete(`/api/workspaces/${t.ws}/members/${t.ids.carol}`).expect(204);
    expect((await body(t.alice.get(`/api/sales/leads/${l.id}`))).owner_id).toBeNull();
    expect((await body(t.alice.get(`/api/sales/accounts/${a.id}`))).owner_id).toBeNull();
    expect(await body(t.alice.get("/api/sales/workspaces"))).toHaveLength(1);
  });
});

describe("deleting a workspace", () => {
  it("takes its sales records with it and leaves follow-up tasks unlinked", async () => {
    await grant("carol");
    const l = await lead(t.carol, { company: "Prospect Ltd" });
    const q2 = await body(t.carol.post(`/api/sales/leads/${l.id}/qualify`).send({ deal: { title: "Deal", pipeline_id: (await pipeline()).id } }));
    await t.carol.post("/api/sales/followups").send({ deal_id: q2.deal_id, title: "Call back" }).expect(201);
    await body(t.alice.post("/api/sales/forms").send(q({ name: "Site" })), 201);
    await t.alice.delete(`/api/workspaces/${t.ws}`).expect(204);
    for (const table of ["leads", "accounts", "contacts", "deals", "pipelines", "pipeline_stages", "sales_activities", "sales_access", "lead_forms"]) {
      expect(await t.db.get(`SELECT COUNT(*) AS n FROM ${table}`), table).toEqual({ n: 0 });
    }
    const left = (await body(t.carol.get("/api/tasks"))) as unknown as Json[];
    expect(left.find((x) => x.title === "Call back")).toMatchObject({ title: "Call back" });
  });
});

describe("accounts and contacts", () => {
  beforeEach(async () => {
    await grant("carol");
    await grant("frank");
  });

  it("warns about duplicates without revealing records the caller can't see", async () => {
    await account(t.frank, { name: "Globex", website: "https://www.globex.test/about" });
    const hidden = await body(t.carol.post("/api/sales/accounts").send(q({ name: "GLOBEX" })), 409);
    expect(hidden.duplicate).toEqual({ visible: false });
    expect(hidden.error).not.toContain("Globex");
    expect((await body(t.carol.post("/api/sales/accounts").send(q({ name: "Other", website: "globex.test" })), 409)).duplicate).toEqual({ visible: false });
    await account(t.carol, { name: "Globex", allow_duplicate: true });
    const own = await body(t.carol.post("/api/sales/accounts").send(q({ name: "globex" })), 409);
    expect(own.duplicate).toMatchObject({ visible: true, name: "Globex" });
  });

  it("keeps a contact with its account's owner", async () => {
    const a = await account(t.carol);
    const c = await body(t.carol.post("/api/sales/contacts").send(q({ name: "Pat", email: "pat@prospect.test", account_id: a.id })), 201);
    expect((await body(t.carol.get(`/api/sales/contacts/${c.id}`))).owner_id).toBe(t.ids.carol);
    await t.carol.patch(`/api/sales/contacts/${c.id}`).send({ owner_id: t.ids.frank }).expect(400); // follows the account
    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "edit" }] });
    await body(t.carol.patch(`/api/sales/accounts/${a.id}`).send({ owner_id: t.ids.frank }));
    expect((await body(t.alice.get(`/api/sales/contacts/${c.id}`))).owner_id).toBe(t.ids.frank);
    await t.frank.get(`/api/sales/contacts/${c.id}`).expect(200);
    // A second contact with the same email is flagged.
    expect((await body(t.carol.post("/api/sales/contacts").send(q({ name: "Pat again", email: "PAT@prospect.test" })), 409)).duplicate.visible).toBe(true);
  });

  it("shows a person an account without the deals other people own on it", async () => {
    await grant("carol", { enabled: true, grants: [{ owner_id: t.ids.frank, level: "view" }] });
    const a = await account(t.frank);
    const p = (await pipeline()).id;
    await t.frank.post("/api/sales/deals").send(q({ title: "Frank's", account_id: a.id, pipeline_id: p })).expect(201);
    await t.bob.post("/api/sales/deals").send(q({ title: "Bob's", account_id: a.id, pipeline_id: p })).expect(201);
    await t.carol.post("/api/sales/deals").send(q({ title: "Carol's", account_id: a.id, pipeline_id: p })).expect(201);
    // Carol can see Frank's account and Frank's deal, her own deal, but not Bob's.
    expect(((await body(t.carol.get(`/api/sales/accounts/${a.id}`))).deals as Json[]).map((d) => d.title).sort()).toEqual(["Carol's", "Frank's"]);
    expect(((await body(t.carol.get("/api/sales/accounts").query(q()))) as unknown as Json[])[0]).toMatchObject({ open_deals: 2 });
    expect(((await body(t.alice.get(`/api/sales/accounts/${a.id}`))).deals as Json[])).toHaveLength(3);
    // Take the grant away and the account goes with it.
    await grant("carol");
    await t.carol.get(`/api/sales/accounts/${a.id}`).expect(404);
  });

  it("won't delete an account that has deals", async () => {
    const a = await account(t.carol);
    const d = await deal(t.carol, { account_id: a.id });
    await t.carol.delete(`/api/sales/accounts/${a.id}`).expect(409);
    await t.carol.delete(`/api/sales/deals/${d.id}`).expect(204);
    await t.carol.delete(`/api/sales/accounts/${a.id}`).expect(204);
  });
});

describe("leads", () => {
  beforeEach(async () => {
    await grant("carol");
  });

  it("creates, filters and edits leads, and flags a repeated address", async () => {
    const l = await lead(t.carol);
    expect((await body(t.carol.post("/api/sales/leads").send(q({ name: "Again", email: "JO@prospect.test" })), 409)).duplicate.visible).toBe(true);
    await lead(t.carol, { name: "Again", email: "JO@prospect.test", allow_duplicate: true });
    await lead(t.carol, { name: "Bad", email: "nope" }, 400);
    await t.carol.post("/api/sales/leads").send(q({ name: "" })).expect(400);
    expect(((await body(t.carol.get("/api/sales/leads").query(q({ q: "prospect" })))) as unknown as Json[])).toHaveLength(2);
    await body(t.carol.patch(`/api/sales/leads/${l.id}`).send({ status: "working", phone: "123" }));
    expect(((await body(t.carol.get("/api/sales/leads").query(q({ status: "working" })))) as unknown as Json[]).map((x) => x.id)).toEqual([l.id]);
  });

  it("qualifies a lead into an account, a contact and a deal", async () => {
    const l = await lead(t.carol, { company: "Prospect Ltd", job_title: "CTO", phone: "555" });
    const p = await pipeline();
    const r = await body(t.carol.post(`/api/sales/leads/${l.id}/qualify`).send({ deal: { title: "Prospect rollout", pipeline_id: p.id, value: 5000, expected_close: "2026-12-01" } }));
    expect(r).toMatchObject({ id: l.id });
    const got = await body(t.carol.get(`/api/sales/leads/${l.id}`));
    expect(got).toMatchObject({ status: "qualified", account_id: r.account_id, contact_id: r.contact_id, deal_id: r.deal_id });
    const acc = await body(t.carol.get(`/api/sales/accounts/${r.account_id}`));
    expect(acc).toMatchObject({ name: "Prospect Ltd", domain: "prospect.test", owner_id: t.ids.carol });
    expect(acc.contacts[0]).toMatchObject({ name: "Jo Prospect", email: "jo@prospect.test", job_title: "CTO" });
    const d = await body(t.carol.get(`/api/sales/deals/${r.deal_id}`));
    expect(d).toMatchObject({ title: "Prospect rollout", value: 5000, stage_name: "Qualified", account_id: r.account_id, contact_id: r.contact_id, owner_id: t.ids.carol });
    await t.carol.post(`/api/sales/leads/${l.id}/qualify`).send({}).expect(409);
    await t.carol.post(`/api/sales/leads/${l.id}/disqualify`).send({ reason: "x" }).expect(409);
    await t.carol.patch(`/api/sales/leads/${l.id}`).send({ name: "Renamed" }).expect(409);
  });

  it("attaches to an existing account, and warns when a new one would repeat one", async () => {
    const a = await account(t.carol, { name: "Initech", website: "https://initech.test" });
    const l = await lead(t.carol, { company: "Initech", email: "bill@initech.test" });
    const dup = await body(t.carol.post(`/api/sales/leads/${l.id}/qualify`).send({}), 409);
    expect(dup.duplicate).toMatchObject({ visible: true, id: a.id });
    const r = await body(t.carol.post(`/api/sales/leads/${l.id}/qualify`).send({ account: { id: a.id } }));
    expect(r.account_id).toBe(a.id);
    expect((await body(t.carol.get(`/api/sales/accounts/${a.id}`))).contacts).toHaveLength(1);
    // Someone else's account can't be used without editing it.
    await grant("frank");
    const theirs = await account(t.frank, { name: "Hooli", website: "https://hooli.test" });
    const l2 = await lead(t.carol, { email: "x@y.test" });
    await t.carol.post(`/api/sales/leads/${l2.id}/qualify`).send({ account: { id: theirs.id } }).expect(404);
  });

  it("disqualifies with a reason and can reopen", async () => {
    const l = await lead(t.carol);
    await t.carol.post(`/api/sales/leads/${l.id}/disqualify`).send({}).expect(400);
    await body(t.carol.post(`/api/sales/leads/${l.id}/disqualify`).send({ reason: "No budget" }));
    expect(await body(t.carol.get(`/api/sales/leads/${l.id}`))).toMatchObject({ status: "disqualified", disqualified_reason: "No budget" });
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[])).toHaveLength(0); // not "open" any more
    await t.carol.post(`/api/sales/leads/${l.id}/reopen`).expect(200);
    expect((await body(t.carol.get(`/api/sales/leads/${l.id}`))).status).toBe("working");
    await t.carol.post(`/api/sales/leads/${l.id}/reopen`).expect(409);
  });

  it("moves a new lead to working on the first logged contact", async () => {
    const l = await lead(t.carol);
    await body(t.carol.post("/api/sales/activities").send({ lead_id: l.id, kind: "call", subject: "Intro call", duration_min: 15 }), 201);
    const got = await body(t.carol.get(`/api/sales/leads/${l.id}`));
    expect(got.status).toBe("working");
    expect(got.activities[0]).toMatchObject({ kind: "call", subject: "Intro call", duration_min: 15 });
  });
});

describe("the lead form", () => {
  let token: string;
  let formId: number;
  beforeEach(async () => {
    const f = await body(t.alice.post("/api/sales/forms").send(q({ name: "Website" })), 201);
    token = f.token;
    formId = f.id;
  });
  const submit = (over: Json = {}, tk = token) => request(t.app).post(`/api/public/leads/${tk}`).send({ name: "Visitor", email: "visitor@site.test", message: "Tell me more", ...over });

  it("is for admins to manage", async () => {
    await grant("carol");
    await t.carol.get("/api/sales/forms").query(q()).expect(403);
    await t.carol.post("/api/sales/forms").send(q({ name: "x" })).expect(403);
    expect(((await body(t.bob.get("/api/sales/forms").query(q()))) as unknown as Json[])).toHaveLength(1);
  });

  it("turns a submission into an unassigned lead and tells the people who keep the inbox", async () => {
    expect((await request(t.app).get(`/api/public/leads/${token}`).expect(200)).body).toMatchObject({ name: "Website", workspace: "Acme" });
    await submit().expect(201);
    const leads = (await body(t.alice.get("/api/sales/leads").query(q({ unassigned: 1 })))) as unknown as Json[];
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ name: "Visitor", email: "visitor@site.test", source: "form", source_detail: "Website", owner_id: null, status: "new" });
    const alerts = (await body(t.bob.get("/api/alerts"))) as Json;
    expect((alerts.items as Json[]).some((a) => a.kind === "lead" && a.title.includes("Visitor"))).toBe(true);
    // Carol sees neither the lead nor an alert until she is given the inbox.
    await grant("carol");
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[])).toHaveLength(0);
    await grant("carol", { enabled: true, unassigned: "edit" });
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[])).toHaveLength(1);
    const id = leads[0].id;
    await t.carol.patch(`/api/sales/leads/${id}`).send({ owner_id: t.ids.carol }).expect(200); // taking it from the inbox
  });

  it("puts a repeat message from the same person on their open lead", async () => {
    await submit().expect(201);
    await submit({ message: "Any news?" }).expect(201);
    const leads = (await body(t.alice.get("/api/sales/leads").query(q()))) as unknown as Json[];
    expect(leads).toHaveLength(1);
    const full = await body(t.alice.get(`/api/sales/leads/${leads[0].id}`));
    expect(full.activities[0]).toMatchObject({ kind: "note", body: "Any news?" });
  });

  it("checks the form, ignores bots, and stops when switched off or changed", async () => {
    await submit({ email: "nope" }).expect(400);
    await submit({ name: "" }).expect(400);
    await submit({ website: "http://spam.test" }).expect(201); // looks fine to the bot…
    expect(((await body(t.alice.get("/api/sales/leads").query(q()))) as unknown as Json[])).toHaveLength(0); // …but nothing is kept
    await request(t.app).get("/api/public/leads/short").expect(404);
    await request(t.app).post(`/api/public/leads/${"a".repeat(24)}`).send({ name: "x", email: "x@y.test" }).expect(404);
    await body(t.alice.patch(`/api/sales/forms/${formId}`).send({ enabled: false }));
    await submit().expect(404);
    await body(t.alice.patch(`/api/sales/forms/${formId}`).send({ enabled: true, rotate: true }));
    await submit().expect(404); // the old link is dead
  });

  it("limits how often one visitor can send", async () => {
    for (let i = 0; i < 5; i++) await submit({ email: `v${i}@site.test` }).expect(201);
    await submit({ email: "v9@site.test" }).expect(429);
  });
});

describe("importing leads", () => {
  const csv = "Full Name,E-mail,Company Name,Phone\nAda Lovelace,ada@math.test,Analytical,111\nGrace Hopper,grace@navy.test,Navy,\n,nobody@x.test,NoName,\nBad Mail,not-an-email,X,\nAda Again,ADA@math.test,Analytical,\n";
  const imp = (a: Agent, over: Json = {}, status = 200) => body(a.post("/api/sales/leads/import").send(q({ csv, ...over })), status);

  it("suggests a column mapping from the headers", async () => {
    const r = await imp(t.alice);
    expect(r).toMatchObject({ headers: ["Full Name", "E-mail", "Company Name", "Phone"], rows: 5, suggested: { name: "Full Name", email: "E-mail", company: "Company Name", phone: "Phone" } });
    expect(r.sample).toHaveLength(3);
  });

  it("imports the good rows, skips repeats, and says what went wrong with the rest", async () => {
    const mapping = { name: "Full Name", email: "E-mail", company: "Company Name", phone: "Phone" };
    const r = await imp(t.alice, { mapping });
    expect(r).toMatchObject({ created: 2, skipped: 1, failed: 2 });
    expect(r.errors).toEqual([{ row: 4, message: "No name" }, { row: 5, message: '"not-an-email" isn\'t an email address' }]);
    const leads = (await body(t.alice.get("/api/sales/leads").query(q()))) as unknown as Json[];
    expect(leads.map((l) => l.name).sort()).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(leads[0]).toMatchObject({ source: "import", source_detail: "CSV import", owner_id: null }); // an admin's import lands in the inbox
    const again = await imp(t.alice, { mapping });
    expect(again).toMatchObject({ created: 0, skipped: 3 });
    expect((await imp(t.alice, { mapping, on_duplicate: "create" })).created).toBe(3);
  });

  it("needs a name column, known fields, and an owner the importer may use", async () => {
    await imp(t.alice, { mapping: { email: "E-mail" } }, 400);
    await imp(t.alice, { mapping: { name: "Nope" } }, 400);
    await imp(t.alice, { mapping: { name: "Full Name", salary: "Phone" } }, 400);
    await imp(t.alice, { csv: "Name\n" }, 400);
    await grant("carol");
    await imp(t.carol, { mapping: { name: "Full Name" }, owner_id: t.ids.frank }, 403);
    await imp(t.carol, { mapping: { name: "Full Name" }, owner_id: null }, 403); // no access to the inbox
    const r = await imp(t.carol, { mapping: { name: "Full Name", email: "E-mail" } });
    expect(r.created).toBe(2);
    expect(((await body(t.carol.get("/api/sales/leads").query(q()))) as unknown as Json[]).every((l) => l.owner_id === t.ids.carol)).toBe(true);
  });
});

describe("pipelines and deals", () => {
  beforeEach(async () => {
    await grant("carol");
    await grant("frank");
  });

  it("starts a workspace with a default pipeline", async () => {
    const p = await pipeline();
    expect(p).toMatchObject({ name: "Sales", currency: "USD" });
    expect((p.stages as Json[]).map((s) => [s.name, s.kind, s.probability])).toEqual([["Qualified", "open", 20], ["Proposal", "open", 40], ["Negotiation", "open", 70], ["Won", "won", 100], ["Lost", "lost", 0]]);
    expect((await body(t.carol.get("/api/sales/me").query(q()))).pipelines).toHaveLength(1); // not duplicated
  });

  it("creates a deal in the first open stage, and closes and reopens it as it moves", async () => {
    const d = await deal(t.carol, { value: 2500, expected_close: "2026-11-30" });
    const got = await body(t.carol.get(`/api/sales/deals/${d.id}`));
    expect(got).toMatchObject({ stage_name: "Qualified", stage_kind: "open", value: 2500, closed_at: null, owner_id: t.ids.carol });
    const won = await stageNamed("Won");
    await body(t.carol.patch(`/api/sales/deals/${d.id}`).send({ stage_id: won.id }));
    const closed = await body(t.carol.get(`/api/sales/deals/${d.id}`));
    expect(closed.stage_kind).toBe("won");
    expect(closed.closed_at).toBeTruthy();
    expect(closed.activities[0].body).toBe("Moved from Qualified to Won");
    const lost = await stageNamed("Lost");
    await body(t.carol.patch(`/api/sales/deals/${d.id}`).send({ stage_id: lost.id, lost_reason: "Went with a rival" }));
    expect(await body(t.carol.get(`/api/sales/deals/${d.id}`))).toMatchObject({ stage_kind: "lost", lost_reason: "Went with a rival" });
    await body(t.carol.patch(`/api/sales/deals/${d.id}`).send({ stage_id: (await stageNamed("Proposal")).id }));
    expect(await body(t.carol.get(`/api/sales/deals/${d.id}`))).toMatchObject({ stage_kind: "open", closed_at: null, lost_reason: "" });
  });

  it("checks a deal's details", async () => {
    await deal(t.carol, { value: -5 }, 400);
    await deal(t.carol, { expected_close: "tomorrow" }, 400);
    await deal(t.carol, { title: "" }, 400);
    await deal(t.carol, { account_id: 99999 }, 404);
    await deal(t.carol, { stage_id: 99999 }, 400);
    await t.carol.post("/api/sales/deals").send(q({ title: "No account", pipeline_id: (await pipeline()).id })).expect(400);
    const other = await account(t.frank, { name: "Frank's co" });
    await deal(t.carol, { account_id: other.id }, 404); // can't see it
    const mine = await account(t.carol, { name: "Mine" });
    const elsewhere = await account(t.carol, { name: "Elsewhere" });
    const stranger = await body(t.carol.post("/api/sales/contacts").send(q({ name: "Someone", account_id: elsewhere.id })), 201);
    await deal(t.carol, { account_id: mine.id, contact_id: stranger.id }, 400); // belongs to a different account
    const d = await deal(t.carol);
    await t.carol.patch(`/api/sales/deals/${d.id}`).send({ account_id: null }).expect(400);
    await t.carol.patch(`/api/sales/deals/${d.id}`).send({ pipeline_id: (await pipeline()).id + 99 }).expect(400);
  });

  it("lists deals by state, owner and search, and flags the stalled ones", async () => {
    const a = await deal(t.carol, { title: "Alpha" });
    const b = await deal(t.frank, { title: "Beta" });
    await body(t.carol.patch(`/api/sales/deals/${a.id}`).send({ stage_id: (await stageNamed("Won")).id }));
    await t.db.run("UPDATE deals SET last_activity_at = ? WHERE id = ?", new Date(Date.now() - 20 * 86_400_000).toISOString(), b.id);
    const list = async (a2: Agent, params: Json = {}) => (await body(a2.get("/api/sales/deals").query(q(params)))) as unknown as Json[];
    expect((await list(t.alice)).map((d) => d.title).sort()).toEqual(["Alpha", "Beta"]);
    expect((await list(t.alice, { state: "won" })).map((d) => d.title)).toEqual(["Alpha"]);
    const open = await list(t.alice, { state: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: "Beta", stalled: true });
    expect((await list(t.alice, { owner_id: t.ids.carol })).map((d) => d.title)).toEqual(["Alpha"]);
    expect((await list(t.alice, { q: "bet" })).map((d) => d.title)).toEqual(["Beta"]);
    expect((await list(t.carol)).map((d) => d.title)).toEqual(["Alpha"]); // Frank's isn't hers to see
  });

  it("forecasts what the caller can see: weighted by stage, with won, lost, owners and stalled deals", async () => {
    const proposal = await stageNamed("Proposal");
    await deal(t.carol, { title: "A", value: 1000 }); // Qualified 20%
    await deal(t.carol, { title: "B", value: 2000, stage_id: proposal.id, expected_close: "2030-01-15" }); // Proposal 40%
    const c = await deal(t.frank, { title: "C", value: 4000, stage_id: (await stageNamed("Negotiation")).id }); // 70%
    const w = await deal(t.carol, { title: "W", value: 3000 });
    await body(t.carol.patch(`/api/sales/deals/${w.id}`).send({ stage_id: (await stageNamed("Won")).id }));
    const l = await deal(t.carol, { title: "L", value: 500 });
    await body(t.carol.patch(`/api/sales/deals/${l.id}`).send({ stage_id: (await stageNamed("Lost")).id }));
    await t.db.run("UPDATE deals SET last_activity_at = ? WHERE id = ?", new Date(Date.now() - 30 * 86_400_000).toISOString(), c.id);

    const all = await body(t.alice.get("/api/sales/forecast").query(q()));
    expect(all.forecast).toMatchObject({ open_count: 3, open_value: 7000, weighted_value: 1000 * 0.2 + 2000 * 0.4 + 4000 * 0.7, won_count: 1, won_value: 3000, lost_count: 1, win_rate: 50 });
    expect(all.stalled).toEqual([expect.objectContaining({ title: "C", days: 30 })]);
    expect(all.by_owner.map((o: Json) => [o.owner_name, o.open_value])).toEqual([["frank", 4000], ["carol", 3000]]);
    expect(all.avg_cycle_days).not.toBeNull();
    expect(all.forecast.by_month).toEqual([{ month: "2030-01", count: 1, value: 2000, weighted: 800 }]);

    const mine = await body(t.carol.get("/api/sales/forecast").query(q()));
    expect(mine.forecast).toMatchObject({ open_count: 2, open_value: 3000, won_value: 3000 });
    expect(mine.by_owner).toHaveLength(1);
    expect(mine.stalled).toEqual([]);
    const filtered = await body(t.alice.get("/api/sales/forecast").query(q({ owner_id: t.ids.frank })));
    expect(filtered.forecast.open_value).toBe(4000);
  });

  it("counts leads in the same overview, and the inbox only for those who can see it", async () => {
    await lead(t.carol, { email: "a@a.test" });
    await lead(t.alice, { email: "b@b.test", owner_id: null });
    expect((await body(t.alice.get("/api/sales/forecast").query(q()))).leads).toMatchObject({ new: 2, inbox: 1 });
    expect((await body(t.carol.get("/api/sales/forecast").query(q()))).leads).toMatchObject({ new: 1, inbox: null });
  });

  it("keeps a deal in step when its stage is removed or changes meaning", async () => {
    const p = await pipeline();
    const d = await deal(t.carol);
    const stage = await stageNamed("Qualified");
    await t.carol.delete(`/api/sales/stages/${stage.id}`).expect(403); // managers only
    await t.alice.delete(`/api/sales/stages/${stage.id}`).expect(409); // has a deal
    await t.alice.delete(`/api/sales/stages/${stage.id}?move_to=${(await stageNamed("Won")).id}`).expect(204);
    expect(await body(t.carol.get(`/api/sales/deals/${d.id}`))).toMatchObject({ stage_name: "Won", stage_kind: "won" });
    expect((await body(t.carol.get(`/api/sales/deals/${d.id}`))).closed_at).toBeTruthy();
    // The last stage of a kind stays.
    await t.alice.delete(`/api/sales/stages/${(await stageNamed("Lost")).id}`).expect(409);
    await t.alice.patch(`/api/sales/stages/${(await stageNamed("Lost")).id}`).send({ kind: "open" }).expect(409);
    expect(p.id).toBeGreaterThan(0);
  });

  it("lets managers shape pipelines and their stages", async () => {
    const p = await pipeline();
    await t.carol.post("/api/sales/pipelines").send(q({ name: "Renewals" })).expect(403);
    const second = await body(t.bob.post("/api/sales/pipelines").send(q({ name: "Renewals", currency: "eur" })), 201);
    expect(((await me(t.alice)).pipelines as Json[]).map((x) => [x.name, x.currency])).toEqual([["Sales", "USD"], ["Renewals", "EUR"]]);
    const added = await body(t.alice.post(`/api/sales/pipelines/${p.id}/stages`).send({ name: "Demo", probability: 30, color: "#123456" }), 201);
    expect(((await pipeline()).stages as Json[]).map((s) => s.name)).toEqual(["Qualified", "Proposal", "Negotiation", "Demo", "Won", "Lost"]); // placed before the closing ones
    await body(t.alice.patch(`/api/sales/stages/${added.id}`).send({ probability: 35, name: "Demo call" }));
    const order = ((await pipeline()).stages as Json[]).map((s) => s.id).reverse();
    await t.alice.put(`/api/sales/pipelines/${p.id}/stage-order`).send({ ids: order.slice(1) }).expect(400);
    await body(t.alice.put(`/api/sales/pipelines/${p.id}/stage-order`).send({ ids: order }));
    expect(((await pipeline()).stages as Json[]).map((s) => s.id)).toEqual(order);
    await t.alice.post(`/api/sales/pipelines/${p.id}/stages`).send({ name: "Bad", color: "red" }).expect(400);
    await t.alice.patch(`/api/sales/pipelines/${second.id}`).send({ name: "Renewals 2" }).expect(200);
    await deal(t.carol, { pipeline_id: second.id });
    await t.alice.delete(`/api/sales/pipelines/${second.id}`).expect(409); // has a deal
    const d = (await body(t.carol.get("/api/sales/deals").query(q({ pipeline_id: second.id })))) as unknown as Json[];
    await t.carol.delete(`/api/sales/deals/${d[0].id}`).expect(204);
    await t.alice.delete(`/api/sales/pipelines/${second.id}`).expect(204);
    await t.alice.delete(`/api/sales/pipelines/${p.id}`).expect(409); // the last one stays
  });

  it("moves a deal between pipelines only with a stage in the new one", async () => {
    await pipeline(); // the default one first
    const second = await body(t.alice.post("/api/sales/pipelines").send(q({ name: "Other" })), 201);
    const d = await deal(t.carol);
    await t.carol.patch(`/api/sales/deals/${d.id}`).send({ pipeline_id: second.id }).expect(400);
    const target = ((await me(t.alice)).pipelines as Json[]).find((x) => x.id === second.id)!.stages[1];
    await t.carol.patch(`/api/sales/deals/${d.id}`).send({ pipeline_id: second.id, stage_id: target.id }).expect(200);
    expect(await body(t.carol.get(`/api/sales/deals/${d.id}`))).toMatchObject({ pipeline_id: second.id, stage_name: target.name });
  });
});

describe("activities and follow-ups", () => {
  beforeEach(async () => {
    await grant("carol");
    await grant("frank");
  });

  it("logs calls, emails, meetings and notes, and counts a deal as touched", async () => {
    const d = await deal(t.carol);
    await t.db.run("UPDATE deals SET last_activity_at = ? WHERE id = ?", new Date(Date.now() - 30 * 86_400_000).toISOString(), d.id);
    expect((await body(t.carol.get(`/api/sales/deals/${d.id}`))).stalled).toBe(true);
    await body(t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "email", subject: "Sent the proposal", body: "Attached." }), 201);
    const got = await body(t.carol.get(`/api/sales/deals/${d.id}`));
    expect(got.stalled).toBe(false);
    expect(got.activities[0]).toMatchObject({ kind: "email", subject: "Sent the proposal", user_name: "carol" });
    await t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "note" }).expect(400); // says nothing
    await t.carol.post("/api/sales/activities").send({ deal_id: d.id, lead_id: 1, kind: "note", body: "x" }).expect(400); // two targets
    await t.carol.post("/api/sales/activities").send({ kind: "note", body: "x" }).expect(400); // none
    await t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "chat", body: "x" }).expect(400);
    await t.frank.post("/api/sales/activities").send({ deal_id: d.id, kind: "note", body: "x" }).expect(404);
  });

  it("shows an account its contacts' and deals' history together", async () => {
    const a = await account(t.carol);
    const c = await body(t.carol.post("/api/sales/contacts").send(q({ name: "Pat", account_id: a.id })), 201);
    const d = await deal(t.carol, { account_id: a.id });
    await t.carol.post("/api/sales/activities").send({ account_id: a.id, kind: "note", body: "On account" }).expect(201);
    await t.carol.post("/api/sales/activities").send({ contact_id: c.id, kind: "call", subject: "On contact" }).expect(201);
    await t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "meeting", subject: "On deal" }).expect(201);
    const subjects = ((await body(t.carol.get(`/api/sales/accounts/${a.id}`))).activities as Json[]).map((x) => x.subject || x.body);
    expect(subjects).toEqual(expect.arrayContaining(["On account", "On contact", "On deal"]));
  });

  it("lets the author or an admin remove an entry, but never the app's own history", async () => {
    const d = await deal(t.carol);
    await grant("frank", { enabled: true, grants: [{ owner_id: t.ids.carol, level: "edit" }] });
    const id = (await body(t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "note", body: "mine" }), 201)).id;
    await t.frank.delete(`/api/sales/activities/${id}`).expect(403);
    await t.carol.delete(`/api/sales/activities/${id}`).expect(204);
    const id2 = (await body(t.carol.post("/api/sales/activities").send({ deal_id: d.id, kind: "note", body: "again" }), 201)).id;
    await t.bob.delete(`/api/sales/activities/${id2}`).expect(204);
    const system = ((await body(t.carol.get(`/api/sales/deals/${d.id}`))).activities as Json[]).find((x) => x.kind === "system")!;
    await t.alice.delete(`/api/sales/activities/${system.id}`).expect(403);
  });

  it("plans follow-ups as ordinary tasks that point at the record", async () => {
    const d = await deal(t.carol);
    const f = await body(t.carol.post("/api/sales/followups").send({ deal_id: d.id, title: "Send the contract", due_at: "2030-02-01T09:00:00.000Z" }), 201);
    const got = await body(t.carol.get(`/api/sales/deals/${d.id}`));
    expect(got.followups).toEqual([expect.objectContaining({ id: f.id, title: "Send the contract", status: "todo" })]);
    expect(((await body(t.carol.get("/api/tasks"))) as unknown as Json[]).some((x) => x.id === f.id)).toBe(true); // it is in her task list
    expect((await body(t.carol.get("/api/sales/my-followups").query(q()))) as unknown as Json[]).toEqual([expect.objectContaining({ id: f.id, about: "Big deal", deal_id: d.id })]);
    // Someone who can see the deal doesn't see her private task.
    await grant("frank", { enabled: true, grants: [{ owner_id: t.ids.carol, level: "view" }] });
    expect((await body(t.frank.get(`/api/sales/deals/${d.id}`))).followups).toEqual([]);
    await t.frank.post("/api/sales/followups").send({ deal_id: d.id, title: "x" }).expect(201); // seeing is enough to plan your own
    await grant("frank");
    await t.frank.post("/api/sales/followups").send({ deal_id: d.id, title: "x" }).expect(404);
    await t.carol.post("/api/sales/followups").send({ title: "Orphan" }).expect(400);
    // Deleting the deal leaves the task, unlinked.
    await t.carol.delete(`/api/sales/deals/${d.id}`).expect(204);
    expect((await body(t.carol.get(`/api/tasks/${f.id}`))).title).toBe("Send the contract");
  });
});

describe("moving an old pipeline project into Sales", () => {
  const legacy = async (name = "Old leads") => {
    const p = (await t.alice.post("/api/projects").send({ name, workspace_id: t.ws }).expect(201)).body as Json;
    await t.db.run("UPDATE projects SET type = 'pipeline', currency = 'EUR' WHERE id = ?", p.id);
    await seedProjectStatuses(t.db, p.id, "pipeline");
    return p.id as number;
  };

  it("no longer lets pipelines be created as projects", async () => {
    await t.alice.post("/api/projects").send({ name: "Leads", workspace_id: t.ws, type: "pipeline" }).expect(400);
    const p = (await t.alice.post("/api/projects").send({ name: "Plain", workspace_id: t.ws }).expect(201)).body as Json;
    await t.alice.patch(`/api/projects/${p.id}`).send({ type: "pipeline" }).expect(400);
  });

  it("turns its tasks into deals in a pipeline built from its statuses, and shelves the project", async () => {
    const id = await legacy();
    const statuses = ((await t.alice.get("/api/statuses")).body as Json[]).filter((s) => s.project_id === id);
    const status = (n: string) => statuses.find((s) => s.name === n)!.id;
    const open = (await t.carol.post("/api/tasks").send({ title: "Acme Ltd", project_id: id, value: 1200, due_at: "2026-09-01T00:00:00.000Z", assignee_id: t.ids.carol, status_id: status("Qualified") }).expect(201)).body as Json;
    const won = (await t.carol.post("/api/tasks").send({ title: "Globex", project_id: id, value: 800 }).expect(201)).body as Json;
    await t.carol.post(`/api/tasks/${won.id}/complete`).send({ status_id: status("Won") }).expect(200);
    await t.carol.post(`/api/tasks/${open.id}/comments`).send({ body: "Called them" }).expect(201);

    await t.carol.post(`/api/projects/${id}/convert-to-sales`).expect(403);
    const r = await body(t.alice.post(`/api/projects/${id}/convert-to-sales`));
    expect(r).toMatchObject({ deals: 2 });
    const pipelines = (await me(t.alice)).pipelines as Json[];
    const made = pipelines.find((p) => p.id === r.pipeline_id)!;
    expect(made).toMatchObject({ name: "Old leads", currency: "EUR" });
    expect(made.stages.map((s: Json) => [s.name, s.kind, s.probability])).toEqual([["New", "open", 10], ["Contacted", "open", 25], ["Qualified", "open", 60], ["Won", "won", 100], ["Lost", "lost", 0]]);

    const deals = (await body(t.alice.get("/api/sales/deals").query(q({ pipeline_id: r.pipeline_id })))) as unknown as Json[];
    const acme = deals.find((d) => d.title === "Acme Ltd")!;
    expect(acme).toMatchObject({ value: 1200, expected_close: "2026-09-01", stage_name: "Qualified", stage_kind: "open", owner_id: t.ids.carol });
    expect(deals.find((d) => d.title === "Globex")).toMatchObject({ stage_kind: "won" });
    expect((await body(t.alice.get(`/api/sales/deals/${acme.id}`))).activities.some((a: Json) => a.body === "Called them")).toBe(true);
    expect(((await body(t.alice.get(`/api/projects/${id}/overview`))) as Json).project.stage).toBe("archived");
    await t.alice.get(`/api/tasks/${open.id}`).expect(404); // the task became the deal
    await t.alice.post(`/api/projects/${id}/convert-to-sales`).expect(400); // it isn't a pipeline any more, so a second run does nothing
  });

  it("only converts pipeline projects", async () => {
    const p = (await t.alice.post("/api/projects").send({ name: "Plain", workspace_id: t.ws }).expect(201)).body as Json;
    await t.alice.post(`/api/projects/${p.id}/convert-to-sales`).expect(400);
    await t.alice.post("/api/projects/99999/convert-to-sales").expect(404);
  });
});
