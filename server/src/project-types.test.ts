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
  const [alice, bob, carol, dave, erin] = await Promise.all(["alice", "bob", "carol", "dave", "erin"].map(signup));
  const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  for (const [agent, email, role] of [[bob, "bob", "admin"], [carol, "carol", "member"], [dave, "dave", "viewer"]] as const) {
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: `${email}@example.com`, role }).expect(201);
    const invite = ((await agent.get("/api/invites")).body as Json[])[0];
    await agent.post(`/api/invites/${invite.id}/accept`).expect(200);
  }
  const project = (await alice.post("/api/projects").send({ name: "Launch", workspace_id: ws }).expect(201)).body.id as number;
  return { db, alice, bob, carol, dave, erin, ids, ws, project };
}

const task = async (a: Agent, body: object, status = 201) => (await a.post("/api/tasks").send(body).expect(status)).body as Json;
const getTask = async (a: Agent, id: number) => (await a.get(`/api/tasks/${id}`).expect(200)).body as Json;
const statuses = async (a: Agent) => (await a.get("/api/statuses").expect(200)).body as Json[];

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});

describe("project types", () => {
  const create = (a: Agent, body: object, status = 201) => a.post("/api/projects").send(body).expect(status).then((r) => r.body as Json);
  const statusNames = async (a: Agent, projectId: number) => (await statuses(a)).filter((s) => s.project_id === projectId).map((s) => `${s.name}:${s.category}`);

  it("starts a project with the statuses that suit its type", async () => {
    const support = await create(t.alice, { name: "Help desk", workspace_id: t.ws, type: "support" });
    expect(support.type).toBe("support");
    expect(await statusNames(t.carol, support.id)).toEqual(["New:todo", "In progress:doing", "Waiting on customer:doing", "Resolved:done"]);
    const pipeline = await create(t.alice, { name: "Leads", workspace_id: t.ws, type: "pipeline" });
    expect(await statusNames(t.carol, pipeline.id)).toEqual(["New:todo", "Contacted:doing", "Qualified:doing", "Won:done", "Lost:done"]);
    const delivery = await create(t.alice, { name: "Site", workspace_id: t.ws, type: "delivery" });
    expect(await statusNames(t.carol, delivery.id)).toEqual(["To do:todo", "Doing:doing", "Review:doing", "Done:done"]);
    const plain = await create(t.alice, { name: "Small", workspace_id: t.ws, type: "initiative" });
    expect(await statusNames(t.carol, plain.id)).toEqual([]); // the built-in three
  });

  it("defaults to an initiative, and rejects an unknown type", async () => {
    expect((await create(t.alice, { name: "Plain", workspace_id: t.ws })).type).toBe("initiative");
    await create(t.alice, { name: "Odd", type: "banana" }, 400);
  });

  it("puts a new task in the type's first status, and moves it through the pipeline", async () => {
    const leads = await create(t.alice, { name: "Leads", workspace_id: t.ws, type: "pipeline" });
    const lead = await task(t.carol, { title: "Acme Ltd", project_id: leads.id });
    const list = await statuses(t.carol);
    expect(list.find((s) => s.id === lead.status_id)?.name).toBe("New");
    const won = list.find((s) => s.project_id === leads.id && s.name === "Won")!;
    const done = (await t.carol.post(`/api/tasks/${lead.id}/complete`).send({ status_id: won.id }).expect(200)).body.completed as Json;
    expect(done).toMatchObject({ status: "done", status_id: won.id });
  });

  it("accepts details when creating, and checks them", async () => {
    const p = await create(t.bob, { name: "Full", workspace_id: t.ws, type: "delivery", description: "Go", lead_id: t.ids.carol, start_date: "2026-01-01", target_date: "2026-06-01" });
    expect(p).toMatchObject({ description: "Go", lead_id: t.ids.carol, start_date: "2026-01-01", target_date: "2026-06-01" });
    await create(t.bob, { name: "Bad lead", workspace_id: t.ws, lead_id: t.ids.erin }, 400);
    await create(t.bob, { name: "Bad dates", workspace_id: t.ws, start_date: "2026-06-01", target_date: "2026-01-01" }, 400);
    expect(((await t.carol.get("/api/portfolio")).body as Json[]).find((x) => x.id === p.id)?.type).toBe("delivery");
  });

  it("can change a project's type later without touching its statuses", async () => {
    const p = await create(t.alice, { name: "Shifting", workspace_id: t.ws, type: "delivery" });
    const r = (await t.alice.patch(`/api/projects/${p.id}`).send({ type: "support" }).expect(200)).body as Json;
    expect(r.type).toBe("support");
    expect((await statusNames(t.alice, p.id)).length).toBe(4);
  });
});

describe("start dates and milestone tasks", () => {
  const milestone = async (a: Agent, projectId: number, name: string, due: string | null = null) =>
    (await a.post(`/api/projects/${projectId}/milestones`).send({ name, due_date: due }).expect(201)).body as Json;

  it("won't accept a start after the due date", async () => {
    await task(t.carol, { title: "Backwards", project_id: t.project, start_at: "2026-03-10T09:00:00.000Z", due_at: "2026-03-09T09:00:00.000Z" }, 400);
    const a = await task(t.carol, { title: "Ok", project_id: t.project, start_at: "2026-03-01T09:00:00.000Z", due_at: "2026-03-05T09:00:00.000Z" });
    expect(a.start_at).toBe("2026-03-01T09:00:00.000Z");
    await t.carol.patch(`/api/tasks/${a.id}`).send({ start_at: "2026-03-06T09:00:00.000Z" }).expect(400);
    await t.carol.patch(`/api/tasks/${a.id}`).send({ due_at: "2026-02-01T09:00:00.000Z" }).expect(400);
    const r = (await t.carol.patch(`/api/tasks/${a.id}`).send({ start_at: null }).expect(200)).body as Json;
    expect(r.start_at).toBeNull();
  });

  it("puts a task in a milestone of its own project only", async () => {
    const m = await milestone(t.carol, t.project, "Beta");
    const other = (await t.alice.post("/api/projects").send({ name: "Other", workspace_id: t.ws }).expect(201)).body.id as number;
    const foreign = await milestone(t.carol, other, "Elsewhere");
    const a = await task(t.carol, { title: "In beta", project_id: t.project, milestone_id: m.id });
    expect(a.milestone_id).toBe(m.id);
    await task(t.carol, { title: "Wrong", project_id: t.project, milestone_id: foreign.id }, 400);
    await t.carol.patch(`/api/tasks/${a.id}`).send({ milestone_id: foreign.id }).expect(400);
    await t.carol.patch(`/api/tasks/${a.id}`).send({ milestone_id: 999999 }).expect(400);
    await task(t.carol, { title: "No project", milestone_id: m.id }, 400);
    expect(((await t.carol.patch(`/api/tasks/${a.id}`).send({ milestone_id: null }).expect(200)).body as Json).milestone_id).toBeNull();
  });

  it("drops the milestone when a task moves to another project, and when the milestone is deleted", async () => {
    const m = await milestone(t.carol, t.project, "Beta");
    const other = (await t.alice.post("/api/projects").send({ name: "Other", workspace_id: t.ws }).expect(201)).body.id as number;
    const a = await task(t.carol, { title: "Moves", project_id: t.project, milestone_id: m.id });
    expect(((await t.carol.patch(`/api/tasks/${a.id}`).send({ project_id: other }).expect(200)).body as Json).milestone_id).toBeNull();
    const b = await task(t.carol, { title: "Stays", project_id: t.project, milestone_id: m.id });
    await t.carol.delete(`/api/milestones/${m.id}`).expect(204);
    expect((await getTask(t.carol, b.id)).milestone_id).toBeNull();
  });

  it("shows each milestone's progress and flags the ones that are slipping", async () => {
    const m = await milestone(t.carol, t.project, "Beta", "2026-03-20");
    const empty = await milestone(t.carol, t.project, "Later", "2030-01-01");
    const a = await task(t.carol, { title: "A", project_id: t.project, milestone_id: m.id, due_at: "2026-03-10T09:00:00.000Z" });
    await task(t.carol, { title: "B", project_id: t.project, milestone_id: m.id, due_at: "2026-03-25T09:00:00.000Z" }); // after the milestone's date
    await t.carol.post(`/api/tasks/${a.id}/complete`).expect(200);
    const o = (await t.carol.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    const beta = o.milestones.find((x: Json) => x.id === m.id);
    expect(beta).toMatchObject({ tasks_total: 2, tasks_done: 1, tasks_late: 1, overdue: true });
    expect(o.milestones.find((x: Json) => x.id === empty.id)).toMatchObject({ tasks_total: 0, tasks_late: 0, overdue: false });
    expect(o.progress).toMatchObject({ milestones_total: 2, progress_pct: 50 });
    expect(o.progress.signals.map((s: Json) => s.code)).toEqual(expect.arrayContaining(["overdue_tasks", "milestone_overdue"]));
    expect(o.progress.suggested_health).toBe("at_risk");
  });

  it("keeps the lead time when a recurring task repeats", async () => {
    const a = await task(t.carol, { title: "Weekly", project_id: t.project, start_at: "2026-03-02T09:00:00.000Z", due_at: "2026-03-04T09:00:00.000Z", recurrence: { freq: "weekly", interval: 1 } });
    const r = (await t.carol.post(`/api/tasks/${a.id}/complete`).expect(200)).body.next as Json;
    expect(r.due_at).toBe("2026-03-11T09:00:00.000Z");
    expect(r.start_at).toBe("2026-03-09T09:00:00.000Z");
  });

  it("drops subtasks' milestones when their parent moves out of the project", async () => {
    const m = await milestone(t.alice, t.project, "Beta");
    const parent = await task(t.alice, { title: "Parent", project_id: t.project, milestone_id: m.id });
    const child = await task(t.alice, { title: "Child", parent_id: parent.id, milestone_id: m.id });
    expect(child.milestone_id).toBe(m.id);
    await t.alice.patch(`/api/tasks/${parent.id}`).send({ project_id: null }).expect(200);
    expect((await getTask(t.alice, child.id)).milestone_id).toBeNull();
  });
});

describe("the attention page", () => {
  const attention = async (a: Agent) => (await a.get("/api/attention").expect(200)).body as Json;
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const titles = (x: Json) => x.items.map((i: Json) => i.title).sort();

  it("shows a member their own overdue work, and a manager the team's", async () => {
    await task(t.carol, { title: "Carol late", project_id: t.project, assignee_id: t.ids.carol, due_at: past });
    await task(t.alice, { title: "Bob late", project_id: t.project, assignee_id: t.ids.bob, due_at: past });
    await task(t.alice, { title: "Not late", project_id: t.project, assignee_id: t.ids.carol, due_at: new Date(Date.now() + 86_400_000).toISOString() });
    const done = await task(t.alice, { title: "Done late", project_id: t.project, assignee_id: t.ids.carol, due_at: past });
    await t.alice.post(`/api/tasks/${done.id}/complete`).expect(200);

    const carol = await attention(t.carol);
    expect(carol.is_manager).toBe(false);
    expect(titles(carol.overdue)).toEqual(["Carol late"]);
    expect(carol.overdue.total).toBe(1);

    const bob = await attention(t.bob); // an admin
    expect(bob.is_manager).toBe(true);
    expect(titles(bob.overdue)).toEqual(["Bob late", "Carol late"]);
    expect(await attention(t.erin)).toMatchObject({ is_manager: false, overdue: { total: 0 } });
  });

  it("lists blocked work", async () => {
    const first = await task(t.alice, { title: "First", project_id: t.project, assignee_id: t.ids.carol });
    const second = await task(t.alice, { title: "Second", project_id: t.project, assignee_id: t.ids.carol });
    await t.alice.post(`/api/tasks/${second.id}/deps`).send({ blocked_by_id: first.id }).expect(201);
    expect(titles((await attention(t.carol)).blocked)).toEqual(["Second"]);
    await t.alice.post(`/api/tasks/${first.id}/complete`).expect(200);
    expect((await attention(t.carol)).blocked.total).toBe(0);
  });

  it("shows unassigned work and workload only to people who manage the workspace", async () => {
    await task(t.carol, { title: "Nobody", project_id: t.project });
    await task(t.carol, { title: "Carol one", project_id: t.project, assignee_id: t.ids.carol, due_at: past });
    await task(t.carol, { title: "Carol two", project_id: t.project, assignee_id: t.ids.carol });
    const carol = await attention(t.carol);
    expect(carol.unassigned.total).toBe(0);
    expect(carol.workload).toEqual([]);

    const bob = await attention(t.bob);
    expect(titles(bob.unassigned)).toEqual(["Nobody"]);
    expect(bob.workload).toEqual([
      expect.objectContaining({ workspace_id: t.ws, assignee_id: t.ids.carol, name: "carol", open: 2, overdue: 1 }),
      expect.objectContaining({ workspace_id: t.ws, assignee_id: null, name: null, open: 1, overdue: 0 }),
    ]);
  });

  it("leaves archived and completed projects out", async () => {
    const other = (await t.alice.post("/api/projects").send({ name: "Old", workspace_id: t.ws }).expect(201)).body.id as number;
    await task(t.alice, { title: "Forgotten", project_id: other, assignee_id: t.ids.carol, due_at: past });
    expect((await attention(t.carol)).overdue.total).toBe(1);
    await t.alice.post(`/api/projects/${other}/stage`).send({ stage: "archived" }).expect(200);
    expect((await attention(t.carol)).overdue.total).toBe(0);
  });

  it("flags active projects that are drifting, or that the team rated at risk", async () => {
    await task(t.carol, { title: "Late", project_id: t.project, assignee_id: t.ids.carol, due_at: past });
    await t.alice.post("/api/projects").send({ name: "Calm", workspace_id: t.ws }).expect(201);
    const worried = (await t.alice.post("/api/projects").send({ name: "Worried", workspace_id: t.ws }).expect(201)).body.id as number;
    await t.alice.post(`/api/projects/${worried}/updates`).send({ health: "off_track", body: "Lost the client" }).expect(201);
    const mine = (await t.erin.post("/api/projects").send({ name: "Erin project" }).expect(201)).body.id as number;
    await t.erin.post(`/api/projects/${mine}/updates`).send({ health: "at_risk" }).expect(201);

    const a = await attention(t.carol);
    const names = a.projects.map((p: Json) => p.name);
    expect(names).toEqual(["Worried", "Launch"]); // off track first, then the one with warning signs
    expect(a.projects[1].signals[0].text).toBe("1 task overdue");
    expect(a.projects[0]).toMatchObject({ health: "off_track", workspace_id: t.ws });
    expect((await attention(t.erin)).projects.map((p: Json) => p.name)).toEqual(["Erin project"]);
  });
});
