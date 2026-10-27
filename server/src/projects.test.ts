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

describe("task statuses", () => {
  it("has no custom statuses until someone defines them, and tasks still have a category", async () => {
    expect(await statuses(t.alice)).toEqual([]);
    const a = await task(t.alice, { title: "Plain", project_id: t.project });
    expect(a).toMatchObject({ status: "todo", status_id: null });
  });

  it("seeds the defaults for a workspace and lists them to members only", async () => {
    const seeded = (await t.bob.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201)).body as Json[];
    expect(seeded.map((s) => [s.name, s.category])).toEqual([["To do", "todo"], ["Doing", "doing"], ["Done", "done"]]);
    expect((await statuses(t.carol)).length).toBe(3);
    expect(await statuses(t.erin)).toEqual([]);
    await t.bob.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(409); // already customised
  });

  it("lets only admins manage workspace statuses", async () => {
    const body = { workspace_id: t.ws, name: "Review", category: "doing" };
    await t.carol.post("/api/statuses").send(body).expect(403);
    await t.dave.post("/api/statuses").send(body).expect(403);
    await t.erin.post("/api/statuses").send(body).expect(404);
    const created = (await t.bob.post("/api/statuses").send(body).expect(201)).body as Json;
    expect(created).toMatchObject({ name: "Review", category: "doing", workspace_id: t.ws, project_id: null });
    // the first custom status brings the defaults along, so To do and Done always exist
    expect((await statuses(t.alice)).map((s) => s.name)).toEqual(["To do", "Doing", "Done", "Review"]);
    await t.carol.patch(`/api/statuses/${created.id}`).send({ name: "x" }).expect(403);
    await t.carol.delete(`/api/statuses/${created.id}`).expect(403);
  });

  it("rejects bad input and duplicate names", async () => {
    await t.alice.post("/api/statuses").send({ name: "A", category: "todo" }).expect(400); // no scope
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, project_id: t.project, name: "A", category: "todo" }).expect(400); // two scopes
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "", category: "todo" }).expect(400);
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "A", category: "later" }).expect(400);
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "A", category: "todo", color: "red" }).expect(400);
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201);
    await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "review", category: "todo" }).expect(409);
    await t.alice.patch("/api/statuses/abc").send({ name: "x" }).expect(404);
  });

  it("gives a task the default status of its category and follows the workspace's statuses", async () => {
    const [todo, , done] = (await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201)).body as Json[];
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "In review", category: "doing" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project });
    expect(a).toMatchObject({ status: "todo", status_id: todo.id });

    // choosing a status sets the category too
    const b = (await t.carol.patch(`/api/tasks/${a.id}`).send({ status_id: review.id }).expect(200)).body as Json;
    expect(b).toMatchObject({ status: "doing", status_id: review.id });

    // changing only the category picks that category's default status
    const c = (await t.carol.patch(`/api/tasks/${a.id}`).send({ status: "done" }).expect(200)).body as Json;
    expect(c).toMatchObject({ status: "done", status_id: done.id });
    expect(c.completed_at).toBeTruthy();

    // completing via the complete endpoint keeps it consistent
    const d = await task(t.carol, { title: "D", project_id: t.project, status_id: review.id });
    expect(d).toMatchObject({ status: "doing", status_id: review.id });
    const completed = (await t.carol.post(`/api/tasks/${d.id}/complete`).expect(200)).body.completed as Json;
    expect(completed).toMatchObject({ status: "done", status_id: done.id });
  });

  it("completes into a chosen done status", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const shipped = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Shipped", category: "done" }).expect(201)).body as Json;
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project });
    await t.carol.post(`/api/tasks/${a.id}/complete`).send({ status_id: review.id }).expect(400); // not a done status
    await t.carol.post(`/api/tasks/${a.id}/complete`).send({ status_id: 999999 }).expect(400);
    const r = (await t.carol.post(`/api/tasks/${a.id}/complete`).send({ status_id: shipped.id }).expect(200)).body.completed as Json;
    expect(r).toMatchObject({ status: "done", status_id: shipped.id });
  });

  it("keeps a custom status when only other fields change", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "In review", category: "doing" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project, status_id: review.id });
    const b = (await t.carol.patch(`/api/tasks/${a.id}`).send({ title: "A2", status: "doing" }).expect(200)).body as Json;
    expect(b.status_id).toBe(review.id); // same category: not reset to the first "doing" status
  });

  it("refuses a status that doesn't belong where the task lives, or that contradicts the category", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "In review", category: "doing" }).expect(201)).body as Json;
    const other = (await t.alice.post("/api/projects").send({ name: "Other", workspace_id: t.ws }).expect(201)).body.id as number;
    const own = (await t.alice.post("/api/statuses").send({ project_id: other, name: "Triage", category: "todo" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project });
    await t.carol.patch(`/api/tasks/${a.id}`).send({ status_id: own.id }).expect(400); // another project's status
    await t.carol.patch(`/api/tasks/${a.id}`).send({ status_id: review.id, status: "todo" }).expect(400); // contradiction
    await t.carol.patch(`/api/tasks/${a.id}`).send({ status_id: 999999 }).expect(400);
    await task(t.carol, { title: "B", status_id: review.id }, 400); // a private task has no workspace statuses
  });

  it("gives a project its own statuses, which replace the workspace's for that project", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const other = (await t.alice.post("/api/projects").send({ name: "Other", workspace_id: t.ws }).expect(201)).body.id as number;
    await t.alice.post("/api/statuses").send({ project_id: other, name: "Backlog", category: "todo" }).expect(201);
    const inOther = await task(t.carol, { title: "X", project_id: other });
    const inLaunch = await task(t.carol, { title: "Y", project_id: t.project });
    const list = await statuses(t.carol);
    const nameOf = (id: number) => list.find((s) => s.id === id)?.name;
    expect(nameOf(inOther.status_id)).toBe("To do"); // seeded defaults come first, so the first "todo" is the default
    expect(list.filter((s) => s.project_id === other).map((s) => s.name)).toEqual(["To do", "Doing", "Done", "Backlog"]);
    expect(list.filter((s) => s.workspace_id === t.ws).length).toBe(3);
    expect(inOther.status_id).not.toBe(inLaunch.status_id);

    // moving between projects picks a status valid in the new place
    const moved = (await t.carol.patch(`/api/tasks/${inLaunch.id}`).send({ project_id: other }).expect(200)).body as Json;
    expect(list.find((s) => s.id === moved.status_id)?.project_id).toBe(other);
  });

  it("lets a private project's owner manage its statuses, and nobody else see them", async () => {
    const mine = (await t.erin.post("/api/projects").send({ name: "Mine" }).expect(201)).body.id as number;
    const s = (await t.erin.post("/api/statuses").send({ project_id: mine, name: "Ideas", category: "todo" }).expect(201)).body as Json;
    await t.alice.post("/api/statuses").send({ project_id: mine, name: "Hack", category: "todo" }).expect(404);
    await t.alice.patch(`/api/statuses/${s.id}`).send({ name: "Hacked" }).expect(404);
    expect((await statuses(t.alice)).some((x) => x.project_id === mine)).toBe(false);
    const a = await task(t.erin, { title: "Idea", project_id: mine, status_id: s.id });
    expect(a.status_id).toBe(s.id);
  });

  it("renames and recolours a status, but not its category", async () => {
    const s = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201)).body as Json;
    const r = (await t.alice.patch(`/api/statuses/${s.id}`).send({ name: "QA", color: "#ff0000", category: "done" }).expect(200)).body as Json;
    expect(r).toMatchObject({ name: "QA", color: "#ff0000", category: "doing" });
  });

  it("moves tasks to a sibling when a status is deleted, and keeps at least one To do and Done", async () => {
    const [todo, doing, done] = (await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201)).body as Json[];
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project, status_id: review.id });
    await t.alice.delete(`/api/statuses/${review.id}`).expect(204);
    expect(await getTask(t.carol, a.id)).toMatchObject({ status: "doing", status_id: doing.id });

    await t.alice.delete(`/api/statuses/${todo.id}`).expect(409);
    await t.alice.delete(`/api/statuses/${done.id}`).expect(409);

    // deleting the only "doing" status sends its tasks back to To do
    await t.alice.delete(`/api/statuses/${doing.id}`).expect(204);
    expect(await getTask(t.carol, a.id)).toMatchObject({ status: "todo", status_id: todo.id });
  });

  it("returns to the built-in statuses on reset, keeping each task's category", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201)).body as Json;
    const a = await task(t.carol, { title: "A", project_id: t.project, status_id: review.id });
    await t.carol.delete(`/api/statuses?workspace_id=${t.ws}`).expect(403);
    await t.alice.delete(`/api/statuses?workspace_id=${t.ws}`).expect(204);
    expect(await statuses(t.alice)).toEqual([]);
    expect(await getTask(t.carol, a.id)).toMatchObject({ status: "doing", status_id: null });
  });

  it("filters tasks by status_id", async () => {
    const [, , done] = (await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201)).body as Json[];
    await task(t.carol, { title: "A", project_id: t.project });
    const b = await task(t.carol, { title: "B", project_id: t.project, status_id: done.id });
    const list = (await t.carol.get(`/api/tasks?status_id=${done.id}`).expect(200)).body as Json[];
    expect(list.map((x) => x.id)).toEqual([b.id]);
  });

  it("starts a recurring task's next occurrence in the default To do status", async () => {
    const [todo, , done] = (await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201)).body as Json[];
    const a = await task(t.carol, { title: "Weekly", project_id: t.project, due_at: "2026-03-04T10:00:00.000Z", recurrence: { freq: "weekly", interval: 1 } });
    const r = (await t.carol.post(`/api/tasks/${a.id}/complete`).expect(200)).body as Json;
    expect(r.completed).toMatchObject({ status: "done", status_id: done.id });
    expect(r.next).toMatchObject({ status: "todo", status_id: todo.id });
  });

  it("drops the status of subtasks that leave with a moved task", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const a = await task(t.alice, { title: "Parent", project_id: t.project });
    const sub = await task(t.alice, { title: "Child", parent_id: a.id });
    expect(sub.status_id).not.toBeNull();
    await t.alice.patch(`/api/tasks/${a.id}`).send({ project_id: null }).expect(200); // becomes private
    expect(await getTask(t.alice, sub.id)).toMatchObject({ status_id: null, status: "todo" });
  });
});

describe("project details and life cycle", () => {
  it("starts active, and shows lead, dates and description", async () => {
    const p = (await t.alice.get("/api/projects").expect(200)).body.find((x: Json) => x.id === t.project);
    expect(p).toMatchObject({ stage: "active", description: "", lead_id: null, start_date: null, target_date: null });
  });

  it("lets a manager edit details, and checks the lead and the dates", async () => {
    const r = (await t.bob
      .patch(`/api/projects/${t.project}`)
      .send({ description: "Ship v1", lead_id: t.ids.carol, start_date: "2026-01-05", target_date: "2026-03-31" })
      .expect(200)).body as Json;
    expect(r).toMatchObject({ description: "Ship v1", lead_id: t.ids.carol, start_date: "2026-01-05", target_date: "2026-03-31" });
    await t.bob.patch(`/api/projects/${t.project}`).send({ lead_id: t.ids.erin }).expect(400); // not in the workspace
    await t.bob.patch(`/api/projects/${t.project}`).send({ lead_id: t.ids.dave }).expect(400); // viewers can't lead
    await t.bob.patch(`/api/projects/${t.project}`).send({ target_date: "soon" }).expect(400);
    await t.bob.patch(`/api/projects/${t.project}`).send({ target_date: "2026-13-45" }).expect(400);
    await t.carol.patch(`/api/projects/${t.project}`).send({ description: "x" }).expect(403);
    const cleared = (await t.bob.patch(`/api/projects/${t.project}`).send({ lead_id: null, target_date: null }).expect(200)).body as Json;
    expect(cleared).toMatchObject({ lead_id: null, target_date: null, start_date: "2026-01-05" });
  });

  it("only allows the permitted transitions, and records each in the history", async () => {
    const go = (a: Agent, stage: string, extra: object = {}) => a.post(`/api/projects/${t.project}/stage`).send({ stage, ...extra });
    await go(t.alice, "active").expect(409); // already there
    await go(t.alice, "planning").expect(409); // can't go back to planning
    expect((await go(t.alice, "on_hold", { note: "Waiting on budget" }).expect(200)).body.stage).toBe("on_hold");
    await go(t.alice, "completed").expect(409); // on hold must resume first
    await go(t.alice, "active").expect(200);
    await go(t.alice, "completed").expect(200);
    await go(t.alice, "archived").expect(200);
    await go(t.alice, "completed").expect(409);
    await go(t.alice, "active", { note: "Restored" }).expect(200);
    await go(t.alice, "nonsense").expect(400);

    const o = (await t.alice.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    expect(o.updates.filter((u: Json) => u.kind === "stage").map((u: Json) => u.stage)).toEqual(["active", "archived", "completed", "active", "on_hold"]);
    expect(o.updates.find((u: Json) => u.stage === "on_hold")).toMatchObject({ body: "Waiting on budget", author: "alice" });
  });

  it("asks before completing a project that still has open tasks", async () => {
    const a = await task(t.alice, { title: "Open", project_id: t.project });
    const res = await t.alice.post(`/api/projects/${t.project}/stage`).send({ stage: "completed" }).expect(409);
    expect(res.body.error).toMatch(/1 task is still open/);
    await t.alice.post(`/api/projects/${t.project}/stage`).send({ stage: "completed", force: true }).expect(200);
    expect(await getTask(t.alice, a.id)).toMatchObject({ status: "todo" }); // tasks are left as they are
  });

  it("limits who can change the stage", async () => {
    await t.carol.post(`/api/projects/${t.project}/stage`).send({ stage: "on_hold" }).expect(403);
    await t.dave.post(`/api/projects/${t.project}/stage`).send({ stage: "on_hold" }).expect(403);
    await t.erin.post(`/api/projects/${t.project}/stage`).send({ stage: "on_hold" }).expect(404);
    await t.bob.post(`/api/projects/${t.project}/stage`).send({ stage: "on_hold" }).expect(200);
  });

  it("doesn't take new tasks while archived", async () => {
    const a = await task(t.alice, { title: "Existing", project_id: t.project });
    const other = (await t.alice.post("/api/projects").send({ name: "Elsewhere", workspace_id: t.ws }).expect(201)).body.id as number;
    await t.alice.post(`/api/projects/${t.project}/stage`).send({ stage: "archived" }).expect(200);
    await task(t.alice, { title: "New", project_id: t.project }, 409);
    const moving = await task(t.alice, { title: "Moving", project_id: other });
    await t.alice.patch(`/api/tasks/${moving.id}`).send({ project_id: t.project }).expect(409);
    await t.alice.patch(`/api/tasks/${a.id}`).send({ title: "Edited" }).expect(200); // existing tasks stay editable
    await t.alice.post(`/api/projects/${t.project}/stage`).send({ stage: "active" }).expect(200);
    await task(t.alice, { title: "New", project_id: t.project });
  });

  it("works for private projects too", async () => {
    const mine = (await t.erin.post("/api/projects").send({ name: "Solo" }).expect(201)).body.id as number;
    await t.erin.patch(`/api/projects/${mine}`).send({ lead_id: t.ids.erin }).expect(200);
    await t.erin.patch(`/api/projects/${mine}`).send({ lead_id: t.ids.alice }).expect(400);
    await t.erin.post(`/api/projects/${mine}/stage`).send({ stage: "on_hold" }).expect(200);
    await t.alice.post(`/api/projects/${mine}/stage`).send({ stage: "active" }).expect(404);
  });
});

describe("health updates, milestones and the overview", () => {
  it("records health updates from members, newest first", async () => {
    await t.dave.post(`/api/projects/${t.project}/updates`).send({ health: "on_track", body: "x" }).expect(403);
    await t.erin.post(`/api/projects/${t.project}/updates`).send({ health: "on_track" }).expect(404);
    await t.carol.post(`/api/projects/${t.project}/updates`).send({ health: "bogus" }).expect(400);
    await t.carol.post(`/api/projects/${t.project}/updates`).send({ health: "on_track", body: "Going well" }).expect(201);
    const second = (await t.carol.post(`/api/projects/${t.project}/updates`).send({ health: "at_risk", body: "Vendor delay" }).expect(201)).body as Json;
    const o = (await t.dave.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    expect(o.updates.map((u: Json) => u.health)).toEqual(["at_risk", "on_track"]);
    expect(o.progress.health).toBe("at_risk");
    expect(o.updates[0]).toMatchObject({ author: "carol", body: "Vendor delay" });

    await t.bob.delete(`/api/projects/${t.project}/updates/${second.id}`).expect(204); // a manager may remove it
    expect(((await t.dave.get(`/api/projects/${t.project}/overview`)).body as Json).progress.health).toBe("on_track");
  });

  it("only lets an update's author or a manager delete it", async () => {
    const u = (await t.carol.post(`/api/projects/${t.project}/updates`).send({ health: "on_track" }).expect(201)).body as Json;
    await t.dave.delete(`/api/projects/${t.project}/updates/${u.id}`).expect(403);
    await t.erin.delete(`/api/projects/${t.project}/updates/${u.id}`).expect(404);
    await t.carol.delete(`/api/projects/${t.project}/updates/${u.id}`).expect(204);
  });

  it("manages milestones", async () => {
    await t.dave.post(`/api/projects/${t.project}/milestones`).send({ name: "Beta" }).expect(403);
    await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "" }).expect(400);
    const m1 = (await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "Beta", due_date: "2026-02-01" }).expect(201)).body as Json;
    const m2 = (await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "Launch", due_date: "2026-04-01" }).expect(201)).body as Json;
    await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "Someday" }).expect(201);
    await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "Bad", due_date: "tomorrow" }).expect(400);

    await t.carol.post(`/api/milestones/${m1.id}/sign-off`).send({ outcome: "achieved" }).expect(403); // deciding is for the lead or a manager
    const done = (await t.bob.post(`/api/milestones/${m1.id}/sign-off`).send({ outcome: "achieved" }).expect(200)).body as Json;
    expect(done.completed_at).toBeTruthy();
    expect(((await t.bob.post(`/api/milestones/${m1.id}/reopen`).expect(200)).body as Json).completed_at).toBeNull();
    await t.carol.patch(`/api/milestones/${m2.id}`).send({ name: "Go live", due_date: null }).expect(200);
    await t.dave.patch(`/api/milestones/${m2.id}`).send({ name: "x" }).expect(403);
    await t.erin.patch(`/api/milestones/${m2.id}`).send({ name: "x" }).expect(404);
    await t.erin.delete(`/api/milestones/${m2.id}`).expect(404);
    await t.carol.patch("/api/milestones/abc").send({ name: "x" }).expect(404);

    const o = (await t.dave.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    expect(o.milestones.map((m: Json) => m.name)).toEqual(["Beta", "Go live", "Someday"]); // dated first, then by order
    await t.carol.delete(`/api/milestones/${m2.id}`).expect(204);
  });

  it("summarises progress, statuses, workload and time", async () => {
    await t.alice.post("/api/statuses/defaults").send({ workspace_id: t.ws }).expect(201);
    const review = (await t.alice.post("/api/statuses").send({ workspace_id: t.ws, name: "Review", category: "doing" }).expect(201)).body as Json;
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const a = await task(t.carol, { title: "A", project_id: t.project, assignee_id: t.ids.carol, due_at: past, estimate_min: 60 });
    await task(t.carol, { title: "B", project_id: t.project, status_id: review.id, estimate_min: 30 });
    const c = await task(t.carol, { title: "C", project_id: t.project });
    await t.carol.post(`/api/tasks/${c.id}/complete`).expect(200);
    await task(t.carol, { title: "Sub", project_id: t.project, parent_id: a.id }); // subtasks aren't counted separately
    await t.carol.post(`/api/projects/${t.project}/milestones`).send({ name: "M1", due_date: "2026-06-01" }).expect(201);

    const o = (await t.dave.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    expect(o.progress).toMatchObject({ tasks_total: 3, tasks_done: 1, tasks_doing: 1, tasks_overdue: 1, milestones_total: 1, milestones_done: 0 });
    expect(o.progress.next_milestone).toMatchObject({ name: "M1", due_date: "2026-06-01" });
    expect(Object.fromEntries(o.by_status.map((s: Json) => [s.name, s.count]))).toEqual({ "To do": 1, Doing: 0, Done: 1, Review: 1 });
    expect(o.workload).toEqual(expect.arrayContaining([{ assignee_id: t.ids.carol, open: 1 }, { assignee_id: null, open: 1 }]));
    expect(o.time.estimate_min).toBe(90);
    expect(o.access).toEqual({ can_write: false, can_manage: false, can_sign_off: false });
    expect(o.transitions).toEqual(["on_hold", "completed", "archived"]);
    await t.erin.get(`/api/projects/${t.project}/overview`).expect(404);
    await t.dave.get("/api/projects/abc/overview").expect(404);
  });

  it("uses the built-in statuses in the overview when none are defined", async () => {
    await task(t.carol, { title: "A", project_id: t.project });
    const o = (await t.carol.get(`/api/projects/${t.project}/overview`).expect(200)).body as Json;
    expect(o.by_status.map((s: Json) => [s.name, s.count])).toEqual([["To do", 1], ["Doing", 0], ["Done", 0]]);
  });

  it("lists the portfolio with each project's standing, to members only", async () => {
    const other = (await t.alice.post("/api/projects").send({ name: "Beta", workspace_id: t.ws }).expect(201)).body.id as number;
    await t.alice.post(`/api/projects/${other}/stage`).send({ stage: "on_hold" }).expect(200);
    const d = await task(t.alice, { title: "Done", project_id: t.project });
    await t.alice.post(`/api/tasks/${d.id}/complete`).expect(200);
    await task(t.alice, { title: "Open", project_id: t.project });
    await t.alice.post(`/api/projects/${t.project}/updates`).send({ health: "off_track", body: "Stuck" }).expect(201);
    await t.erin.post("/api/projects").send({ name: "Erin's" }).expect(201);

    const p = (await t.dave.get("/api/portfolio").expect(200)).body as Json[];
    expect(p.map((x) => x.name)).toEqual(["Beta", "Launch"]);
    expect(p.find((x) => x.name === "Launch")).toMatchObject({ stage: "active", tasks_total: 2, tasks_done: 1, health: "off_track" });
    expect(p.find((x) => x.name === "Beta")).toMatchObject({ stage: "on_hold", tasks_total: 0, health: null });
    expect(((await t.erin.get("/api/portfolio")).body as Json[]).map((x) => x.name)).toEqual(["Erin's"]);
  });

  it("removes statuses, milestones and updates with their project", async () => {
    await t.alice.post("/api/statuses").send({ project_id: t.project, name: "Review", category: "doing" }).expect(201);
    await t.alice.post(`/api/projects/${t.project}/milestones`).send({ name: "M" }).expect(201);
    await t.alice.post(`/api/projects/${t.project}/updates`).send({ health: "on_track" }).expect(201);
    await t.alice.delete(`/api/projects/${t.project}`).expect(204);
    for (const table of ["statuses", "milestones", "project_updates"]) {
      expect((await t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, t.project))!.n).toBe(0);
    }
  });
});
