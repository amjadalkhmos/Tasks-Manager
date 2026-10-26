import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { fireDueReminders } from "./reminders.js";

// Hashing cost is the slow part of signing people up; tests use the cheapest setting (production defaults to 10).
process.env.BCRYPT_ROUNDS = "4";

type Agent = ReturnType<typeof request.agent>;
type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

async function signup(app: App, name: string): Promise<{ agent: Agent; id: number; email: string }> {
  const agent = request.agent(app);
  const email = `${name.toLowerCase()}@example.com`;
  const res = await agent.post("/api/auth/register").send({ email, password: "password123", name }).expect(201);
  return { agent, id: res.body.id, email };
}

interface Team {
  app: App;
  db: DB;
  alice: Agent; // owner
  bob: Agent; // admin
  carol: Agent; // member
  dave: Agent; // viewer
  erin: Agent; // outsider
  ids: { alice: number; bob: number; carol: number; dave: number; erin: number };
  ws: number;
  project: number;
}

async function invite(owner: Agent, ws: number, email: string, role: string, invitee: Agent) {
  await owner.post(`/api/workspaces/${ws}/invites`).send({ email, role }).expect(201);
  const pending = (await invitee.get("/api/invites")).body as Json[];
  await invitee.post(`/api/invites/${pending.find((i) => i.workspace_id === ws)!.id}/accept`).expect(200);
}

async function makeTeam(): Promise<Team> {
  const db = openDb(":memory:");
  const app = createApp(db, "s");
  const [a, b, c, d, e] = await Promise.all(["Alice", "Bob", "Carol", "Dave", "Erin"].map((n) => signup(app, n)));
  const ws = (await a.agent.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id as number;
  await invite(a.agent, ws, b.email, "admin", b.agent);
  await invite(a.agent, ws, c.email, "member", c.agent);
  await invite(a.agent, ws, d.email, "viewer", d.agent);
  const project = (await a.agent.post("/api/projects").send({ name: "Launch", workspace_id: ws }).expect(201)).body.id as number;
  db.prepare("DELETE FROM alerts").run(); // start every test with an empty inbox (setup itself generates "invite accepted" alerts)
  return {
    app, db, alice: a.agent, bob: b.agent, carol: c.agent, dave: d.agent, erin: e.agent, ws, project,
    ids: { alice: a.id, bob: b.id, carol: c.id, dave: d.id, erin: e.id },
  };
}

const mk = async (agent: Agent, body: object) => (await agent.post("/api/tasks").send(body).expect(201)).body as Json;
const alerts = async (agent: Agent) => (await agent.get("/api/alerts").expect(200)).body as Json;

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});

describe("workspaces and membership", () => {
  it("creates workspaces with the creator as owner and hides them from outsiders", async () => {
    const list = (await t.alice.get("/api/workspaces")).body as Json[];
    expect(list).toEqual([{ id: t.ws, name: "Acme", role: "owner", member_count: 4 }]);
    expect((await t.erin.get("/api/workspaces")).body).toEqual([]);
    await t.erin.get(`/api/workspaces/${t.ws}`).expect(404);

    const detail = (await t.carol.get(`/api/workspaces/${t.ws}`).expect(200)).body;
    expect(detail.role).toBe("member");
    expect(detail.members.map((m: Json) => [m.name, m.role])).toEqual([["Alice", "owner"], ["Bob", "admin"], ["Carol", "member"], ["Dave", "viewer"]]);
    expect(detail.invites).toEqual([]); // only admins see pending invites
  });

  it("lets admins rename but not members", async () => {
    await t.carol.patch(`/api/workspaces/${t.ws}`).send({ name: "Hax" }).expect(403);
    await t.erin.patch(`/api/workspaces/${t.ws}`).send({ name: "Hax" }).expect(404);
    await t.bob.patch(`/api/workspaces/${t.ws}`).send({ name: "Acme Inc" }).expect(200);
    const feed = (await t.alice.get(`/api/workspaces/${t.ws}/activity`)).body.items as Json[];
    expect(feed[0]).toMatchObject({ kind: "workspace_renamed", detail: { from: "Acme", to: "Acme Inc" } });
  });

  it("limits invitations: admins invite members/viewers, only the owner invites admins, no duplicates", async () => {
    await t.carol.post(`/api/workspaces/${t.ws}/invites`).send({ email: "x@example.com", role: "member" }).expect(403);
    await t.bob.post(`/api/workspaces/${t.ws}/invites`).send({ email: "x@example.com", role: "admin" }).expect(403);
    await t.bob.post(`/api/workspaces/${t.ws}/invites`).send({ email: "x@example.com", role: "viewer" }).expect(201);
    await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "x@example.com", role: "admin" }).expect(201); // upsert: role changes
    const invites = (await t.bob.get(`/api/workspaces/${t.ws}`)).body.invites as Json[];
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: "x@example.com", role: "admin", invited_by: "Alice" });
    await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "carol@example.com", role: "member" }).expect(409);
    await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "not-an-email" }).expect(400);
  });

  it("answers invitations the same whether or not the address has an account", async () => {
    const known = await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "erin@example.com", role: "member" });
    const unknown = await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "nobody@example.com", role: "member" });
    expect(known.status).toBe(unknown.status);
    expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body));
  });

  it("only the addressee can accept or decline, and a later sign-up finds the invite waiting", async () => {
    await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "frank@example.com", role: "member" }).expect(201);
    await t.alice.post(`/api/workspaces/${t.ws}/invites`).send({ email: "erin@example.com", role: "viewer" }).expect(201);
    const erinInvite = ((await t.erin.get("/api/invites")).body as Json[])[0];
    await t.carol.post(`/api/invites/${erinInvite.id}/accept`).expect(404); // not carol's
    expect((await alerts(t.erin)).invites).toBe(1);

    const frank = await signup(t.app, "Frank"); // registered after being invited
    const mine = (await frank.agent.get("/api/invites")).body as Json[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ workspace_name: "Acme", role: "member", invited_by: "Alice" });
    await frank.agent.post(`/api/invites/${mine[0].id}/decline`).expect(204);
    expect((await frank.agent.get("/api/invites")).body).toEqual([]);
    await frank.agent.get(`/api/workspaces/${t.ws}`).expect(404);

    await t.erin.post(`/api/invites/${erinInvite.id}/accept`).expect(200);
    await t.erin.get(`/api/workspaces/${t.ws}`).expect(200);
    expect((await alerts(t.alice)).items.some((a: Json) => a.kind === "invite_accepted" && a.actor_id === t.ids.erin)).toBe(true);
  });

  it("manages roles: owner changes any, admin only member<->viewer, nobody changes their own", async () => {
    await t.carol.patch(`/api/workspaces/${t.ws}/members/${t.ids.dave}`).send({ role: "member" }).expect(403);
    await t.bob.patch(`/api/workspaces/${t.ws}/members/${t.ids.dave}`).send({ role: "member" }).expect(200);
    await t.bob.patch(`/api/workspaces/${t.ws}/members/${t.ids.carol}`).send({ role: "admin" }).expect(403);
    await t.bob.patch(`/api/workspaces/${t.ws}/members/${t.ids.alice}`).send({ role: "viewer" }).expect(403);
    await t.bob.patch(`/api/workspaces/${t.ws}/members/${t.ids.bob}`).send({ role: "member" }).expect(400);
    await t.alice.patch(`/api/workspaces/${t.ws}/members/${t.ids.carol}`).send({ role: "admin" }).expect(200);
    await t.alice.patch(`/api/workspaces/${t.ws}/members/${t.ids.erin}`).send({ role: "member" }).expect(404);
  });

  it("transfers ownership by promoting someone, demoting the former owner to admin", async () => {
    await t.alice.patch(`/api/workspaces/${t.ws}/members/${t.ids.bob}`).send({ role: "owner" }).expect(200);
    const roles = Object.fromEntries(((await t.alice.get(`/api/workspaces/${t.ws}`)).body.members as Json[]).map((m) => [m.name, m.role]));
    expect(roles).toMatchObject({ Alice: "admin", Bob: "owner" });
    await t.alice.delete(`/api/workspaces/${t.ws}`).expect(403);
    await t.bob.delete(`/api/workspaces/${t.ws}`).expect(204);
  });

  it("removing or losing a member unassigns their work, ends their access and tells them", async () => {
    const task = await mk(t.carol, { title: "Carol's job", project_id: t.project, assignee_id: t.ids.carol });
    await t.alice.post(`/api/tasks/${task.id}/comments`).send({ body: "ping @Carol", mentions: [t.ids.carol] }).expect(201);
    expect((await alerts(t.carol)).items.length).toBeGreaterThan(0);
    await t.carol.post(`/api/tasks/${task.id}/timer/start`).expect(201);

    await t.bob.delete(`/api/workspaces/${t.ws}/members/${t.ids.carol}`).expect(204);
    await t.carol.get(`/api/tasks/${task.id}`).expect(404);
    await t.carol.get(`/api/workspaces/${t.ws}`).expect(404);
    expect((await t.alice.get(`/api/tasks/${task.id}`)).body.assignee_id).toBeNull();
    expect((await t.carol.get("/api/timer")).body).toBeNull(); // her running timer was stopped
    const mine = await alerts(t.carol);
    expect(mine.items.map((a: Json) => a.kind)).toEqual(["removed"]); // workspace alerts wiped, only the notice remains
    expect(mine.items[0].title).toBe("Acme");
    expect((await t.carol.get("/api/tasks")).body).toEqual([]);
  });

  it("admins can't remove admins; members can leave; the owner must hand over first", async () => {
    await t.bob.delete(`/api/workspaces/${t.ws}/members/${t.ids.alice}`).expect(403);
    await t.carol.delete(`/api/workspaces/${t.ws}/members/${t.ids.dave}`).expect(403);
    await t.alice.delete(`/api/workspaces/${t.ws}/members/${t.ids.alice}`).expect(409);
    await t.dave.delete(`/api/workspaces/${t.ws}/members/${t.ids.dave}`).expect(204); // leave
    await t.dave.get(`/api/workspaces/${t.ws}`).expect(404);
    await t.alice.delete(`/api/workspaces/${t.ws}/members/${t.ids.bob}`).expect(204); // owner removes an admin
  });

  it("deleting a workspace deletes everything in it and nothing else", async () => {
    const shared = await mk(t.carol, { title: "shared", project_id: t.project });
    const mine = await mk(t.carol, { title: "private" });
    await t.carol.delete(`/api/workspaces/${t.ws}`).expect(403);
    await t.alice.delete(`/api/workspaces/${t.ws}`).expect(204);
    await t.carol.get(`/api/tasks/${shared.id}`).expect(404);
    await t.carol.get(`/api/tasks/${mine.id}`).expect(200);
    expect((await t.carol.get("/api/projects")).body).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) n FROM activity").get()).toEqual({ n: 0 });
  });
});

describe("visibility", () => {
  it("shows shared tasks to members only, and keeps private tasks private", async () => {
    const shared = await mk(t.carol, { title: "Shared", project_id: t.project, tags: ["roadmap"] });
    const priv = await mk(t.carol, { title: "Carol private", tags: ["secret"] });
    const privInProject = (await t.carol.post("/api/projects").send({ name: "Mine" }).expect(201)).body;
    const priv2 = await mk(t.carol, { title: "In private project", project_id: privInProject.id });

    for (const who of [t.alice, t.bob, t.dave]) {
      const titles = ((await who.get("/api/tasks")).body as Json[]).map((x) => x.title);
      expect(titles).toEqual(["Shared"]);
      await who.get(`/api/tasks/${priv.id}`).expect(404);
      await who.get(`/api/tasks/${priv2.id}`).expect(404);
    }
    expect((await t.erin.get("/api/tasks")).body).toEqual([]);
    await t.erin.get(`/api/tasks/${shared.id}`).expect(404);

    // teammates' tags show up for filtering; private tags don't leak
    const tags = ((await t.alice.get("/api/tags")).body as Json[]).map((x) => x.name);
    expect(tags).toContain("roadmap");
    expect(tags).not.toContain("secret");
    expect(((await t.alice.get("/api/tasks?tag=roadmap")).body as Json[]).map((x) => x.title)).toEqual(["Shared"]);

    // projects: members see the workspace project, never someone's private one
    expect(((await t.alice.get("/api/projects")).body as Json[]).map((p) => p.name)).toEqual(["Launch"]);
    expect(((await t.carol.get("/api/projects")).body as Json[]).map((p) => p.name)).toEqual(["Launch", "Mine"]);
    expect((await t.erin.get("/api/projects")).body).toEqual([]);
  });

  it("filters by workspace and by assignee", async () => {
    const a = await mk(t.carol, { title: "A", project_id: t.project, assignee_id: t.ids.carol });
    await mk(t.carol, { title: "B", project_id: t.project });
    await mk(t.carol, { title: "C" });
    expect(((await t.carol.get("/api/tasks?assignee=me")).body as Json[]).map((x) => x.id)).toEqual([a.id]);
    expect(((await t.carol.get("/api/tasks?assignee=none")).body as Json[]).map((x) => x.title).sort()).toEqual(["B", "C"]);
    expect(((await t.carol.get(`/api/tasks?workspace_id=${t.ws}`)).body as Json[]).map((x) => x.title).sort()).toEqual(["A", "B"]);
    expect(((await t.carol.get(`/api/tasks?assignee=${t.ids.carol}`)).body as Json[]).length).toBe(1);
  });

  it("tells each person what they may do, so the UI can hide what would fail", async () => {
    const task = await mk(t.carol, { title: "T", project_id: t.project });
    const seen = async (a: Agent) => (await a.get(`/api/tasks/${task.id}`)).body;
    expect(await seen(t.alice)).toMatchObject({ access: "admin", can_delete: true, workspace_id: t.ws });
    expect(await seen(t.bob)).toMatchObject({ access: "admin", can_delete: true });
    expect(await seen(t.carol)).toMatchObject({ access: "write", can_delete: true });
    expect(await seen(t.dave)).toMatchObject({ access: "read", can_delete: false });
    const other = await mk(t.alice, { title: "Alice's", project_id: t.project });
    expect((await t.carol.get(`/api/tasks/${other.id}`)).body).toMatchObject({ access: "write", can_delete: false });
  });
});

describe("permissions by role", () => {
  it("viewers can read and nothing else", async () => {
    const task = await mk(t.alice, { title: "Read only", project_id: t.project });
    await t.dave.get(`/api/tasks/${task.id}`).expect(200);
    await t.dave.post("/api/tasks").send({ title: "x", project_id: t.project }).expect(403);
    await t.dave.patch(`/api/tasks/${task.id}`).send({ title: "x" }).expect(403);
    await t.dave.post(`/api/tasks/${task.id}/complete`).expect(403);
    await t.dave.delete(`/api/tasks/${task.id}`).expect(403);
    await t.dave.post(`/api/tasks/${task.id}/comments`).send({ body: "hi" }).expect(403);
    await t.dave.post(`/api/tasks/${task.id}/checklist`).send({ text: "x" }).expect(403);
    await t.dave.post(`/api/tasks/${task.id}/timer/start`).expect(403);
    await t.dave.post(`/api/tasks/${task.id}/deps`).send({ blocked_by_id: task.id }).expect(403);
    await t.dave.post("/api/projects").send({ name: "p", workspace_id: t.ws }).expect(403);
    expect((await t.dave.get(`/api/tasks/${task.id}/checklist`)).status).toBe(200);
    expect((await t.dave.get(`/api/tasks/${task.id}/comments`)).status).toBe(200);
  });

  it("members edit anyone's task but delete only their own; admins delete any", async () => {
    const byAlice = await mk(t.alice, { title: "Alice's", project_id: t.project });
    const byCarol = await mk(t.carol, { title: "Carol's", project_id: t.project });
    await t.carol.patch(`/api/tasks/${byAlice.id}`).send({ title: "Edited by Carol", priority: 2 }).expect(200);
    await t.carol.post(`/api/tasks/${byAlice.id}/complete`).expect(200);
    await t.carol.delete(`/api/tasks/${byAlice.id}`).expect(403);
    await t.carol.delete(`/api/tasks/${byCarol.id}`).expect(204);
    await t.bob.delete(`/api/tasks/${byAlice.id}`).expect(204);
    await t.erin.delete(`/api/tasks/${byAlice.id}`).expect(404);
  });

  it("outsiders can't touch a workspace project or put tasks in it", async () => {
    await t.erin.post("/api/tasks").send({ title: "x", project_id: t.project }).expect(400);
    await t.erin.patch(`/api/projects/${t.project}`).send({ name: "hijack" }).expect(404);
    await t.erin.delete(`/api/projects/${t.project}`).expect(404);
    await t.erin.post("/api/projects").send({ name: "x", workspace_id: t.ws }).expect(404);
  });

  it("project management: members rename their own, admins rename any and delete (with the tasks inside)", async () => {
    const carolsProject = (await t.carol.post("/api/projects").send({ name: "Carol's", workspace_id: t.ws }).expect(201)).body;
    await t.carol.patch(`/api/projects/${carolsProject.id}`).send({ name: "Carol's 2" }).expect(200);
    await t.carol.patch(`/api/projects/${t.project}`).send({ name: "x" }).expect(403);
    await t.bob.patch(`/api/projects/${carolsProject.id}`).send({ name: "Bob renamed" }).expect(200);

    const inside = await mk(t.carol, { title: "inside", project_id: carolsProject.id });
    await t.carol.delete(`/api/projects/${carolsProject.id}`).expect(403);
    await t.bob.delete(`/api/projects/${carolsProject.id}`).expect(204);
    await t.alice.get(`/api/tasks/${inside.id}`).expect(404); // deleted, not orphaned into somebody's inbox
    const feed = (await t.alice.get(`/api/workspaces/${t.ws}/activity`)).body.items as Json[];
    expect(feed.find((e) => e.kind === "project_deleted")).toMatchObject({ detail: { name: "Bob renamed", tasks: 1 } });
  });

  it("deleting a private project still returns its tasks to the inbox", async () => {
    const p = (await t.carol.post("/api/projects").send({ name: "Mine" }).expect(201)).body;
    const task = await mk(t.carol, { title: "keep me", project_id: p.id });
    await t.carol.delete(`/api/projects/${p.id}`).expect(204);
    expect((await t.carol.get(`/api/tasks/${task.id}`)).body.project_id).toBeNull();
  });
});

describe("assignment", () => {
  it("assigns to members, notifies them, logs it, and never notifies you about yourself", async () => {
    const task = await mk(t.alice, { title: "Ship it", project_id: t.project, assignee_id: t.ids.carol });
    expect(task.assignee_id).toBe(t.ids.carol);
    const a = (await alerts(t.carol)).items[0];
    expect(a).toMatchObject({ kind: "assigned", actor_id: t.ids.alice, task_id: task.id, title: "Ship it", read: false });

    await mk(t.carol, { title: "Self", project_id: t.project, assignee_id: t.ids.carol });
    expect((await alerts(t.carol)).unread).toBe(1); // no alert for assigning yourself

    await t.alice.patch(`/api/tasks/${task.id}`).send({ assignee_id: null }).expect(200);
    const feed = (await t.alice.get(`/api/tasks/${task.id}/activity`)).body as Json[];
    expect(feed.map((e) => e.kind)).toEqual(["task_unassigned", "task_assigned", "task_created"]);
  });

  it("rejects assignees who can't take the work", async () => {
    const task = await mk(t.alice, { title: "T", project_id: t.project });
    await t.alice.patch(`/api/tasks/${task.id}`).send({ assignee_id: t.ids.dave }).expect(400); // viewer
    await t.alice.patch(`/api/tasks/${task.id}`).send({ assignee_id: t.ids.erin }).expect(400); // outsider
    await t.alice.patch(`/api/tasks/${task.id}`).send({ assignee_id: 99999 }).expect(400);
    const personal = await mk(t.alice, { title: "Personal" });
    await t.alice.patch(`/api/tasks/${personal.id}`).send({ assignee_id: t.ids.bob }).expect(400);
    await t.alice.post("/api/tasks").send({ title: "x", assignee_id: t.ids.bob }).expect(400);
  });

  it("demoting someone to viewer drops their assignments", async () => {
    const task = await mk(t.alice, { title: "T", project_id: t.project, assignee_id: t.ids.carol });
    await t.alice.patch(`/api/workspaces/${t.ws}/members/${t.ids.carol}`).send({ role: "viewer" }).expect(200);
    expect((await t.alice.get(`/api/tasks/${task.id}`)).body.assignee_id).toBeNull();
  });

  it("recurring tasks keep their assignee when the next one spawns", async () => {
    const task = await mk(t.alice, {
      title: "Weekly sync", project_id: t.project, assignee_id: t.ids.carol, due_at: "2026-03-04T10:00:00.000Z", recurrence: { freq: "weekly", interval: 1 },
    });
    const { next } = (await t.carol.post(`/api/tasks/${task.id}/complete`).expect(200)).body;
    expect(next).toMatchObject({ assignee_id: t.ids.carol, project_id: t.project, due_at: "2026-03-11T10:00:00.000Z" });
  });
});

describe("subtasks, moving and dependencies across the private/shared line", () => {
  it("subtasks inherit the parent's project and can't straddle workspaces", async () => {
    const parent = await mk(t.carol, { title: "Parent", project_id: t.project });
    const child = await mk(t.bob, { title: "Child", parent_id: parent.id });
    expect(child.project_id).toBe(t.project);

    const privateTask = await mk(t.carol, { title: "Private" });
    await t.carol.post("/api/tasks").send({ title: "bad", parent_id: privateTask.id, project_id: t.project }).expect(400);
    await t.carol.patch(`/api/tasks/${child.id}`).send({ parent_id: privateTask.id }).expect(400);
    await t.erin.post("/api/tasks").send({ title: "x", parent_id: parent.id }).expect(400);
  });

  it("sharing a private task moves its subtasks with it and clears links that would cross the boundary", async () => {
    const parent = await mk(t.carol, { title: "Plan" });
    const child = await mk(t.carol, { title: "Step", parent_id: parent.id });
    const other = await mk(t.carol, { title: "Unrelated private" });
    await t.carol.post(`/api/tasks/${parent.id}/deps`).send({ blocked_by_id: other.id }).expect(201);

    const moved = (await t.carol.patch(`/api/tasks/${parent.id}`).send({ project_id: t.project }).expect(200)).body;
    expect(moved).toMatchObject({ project_id: t.project, workspace_id: t.ws, blocked_by: [] });
    expect((await t.alice.get(`/api/tasks/${child.id}`)).body).toMatchObject({ project_id: t.project, parent_id: parent.id });
    await t.alice.get(`/api/tasks/${other.id}`).expect(404); // the unrelated task stays private
  });

  it("only the author can take shared work private again; subtasks follow and detach cleanly", async () => {
    const parent = await mk(t.carol, { title: "P", project_id: t.project, assignee_id: t.ids.bob });
    const child = await mk(t.carol, { title: "C", parent_id: parent.id, assignee_id: t.ids.alice });
    await t.bob.patch(`/api/tasks/${parent.id}`).send({ project_id: null }).expect(403); // an admin, but not the author
    const priv = (await t.carol.patch(`/api/tasks/${parent.id}`).send({ project_id: null }).expect(200)).body;
    expect(priv).toMatchObject({ project_id: null, workspace_id: null, assignee_id: null });
    expect((await t.carol.get(`/api/tasks/${child.id}`)).body).toMatchObject({ project_id: null, assignee_id: null, parent_id: parent.id });
    await t.bob.get(`/api/tasks/${parent.id}`).expect(404);
    await t.bob.get(`/api/tasks/${child.id}`).expect(404);
  });

  it("an admin can move shared work to another workspace project but members can't move others' work", async () => {
    const other = (await t.alice.post("/api/workspaces").send({ name: "Other" }).expect(201)).body.id;
    await invite(t.alice, other, "bob@example.com", "member", t.bob);
    const proj2 = (await t.alice.post("/api/projects").send({ name: "Elsewhere", workspace_id: other }).expect(201)).body.id;
    const task = await mk(t.carol, { title: "Movable", project_id: t.project, assignee_id: t.ids.carol });
    await t.alice.patch(`/api/tasks/${task.id}`).send({ project_id: proj2 }).expect(200);
    expect((await t.alice.get(`/api/tasks/${task.id}`)).body).toMatchObject({ workspace_id: other, assignee_id: null }); // carol isn't in "Other"
    await t.carol.get(`/api/tasks/${task.id}`).expect(404);

    const second = await mk(t.alice, { title: "Alice's", project_id: t.project });
    await t.carol.patch(`/api/tasks/${second.id}`).send({ project_id: proj2 }).expect(400); // carol can't see/write the target project
  });

  it("dependencies must stay within one place", async () => {
    const a = await mk(t.carol, { title: "shared A", project_id: t.project });
    const b = await mk(t.carol, { title: "shared B", project_id: t.project });
    const p = await mk(t.carol, { title: "private" });
    await t.carol.post(`/api/tasks/${a.id}/deps`).send({ blocked_by_id: p.id }).expect(400);
    await t.carol.post(`/api/tasks/${p.id}/deps`).send({ blocked_by_id: a.id }).expect(400);
    await t.carol.post(`/api/tasks/${a.id}/deps`).send({ blocked_by_id: b.id }).expect(201);
    await t.bob.post(`/api/tasks/${b.id}/deps`).send({ blocked_by_id: a.id }).expect(400); // cycle
    await t.erin.post(`/api/tasks/${a.id}/deps`).send({ blocked_by_id: b.id }).expect(404);
    expect((await t.dave.get(`/api/tasks/${a.id}`)).body.blocked).toBe(true);
  });
});

describe("comments and mentions", () => {
  it("members comment; mentions notify workspace members, never the author, outsiders or duplicates", async () => {
    const task = await mk(t.alice, { title: "Discuss", project_id: t.project, assignee_id: t.ids.bob });
    const c = (
      await t.carol.post(`/api/tasks/${task.id}/comments`).send({ body: "@Dave please read, @Erin too, and @Carol", mentions: [t.ids.dave, t.ids.erin, t.ids.carol, t.ids.dave] }).expect(201)
    ).body;
    expect(c.mentions.map((m: Json) => m.name)).toEqual(["Dave"]); // erin isn't a member; carol is the author

    const dave = (await alerts(t.dave)).items;
    expect(dave.map((a: Json) => a.kind)).toEqual(["mentioned"]);
    expect((await alerts(t.erin)).items).toEqual([]);
    // the task's creator and assignee hear about it too (but not the commenter)
    expect((await alerts(t.alice)).items.map((a: Json) => a.kind)).toEqual(["commented"]);
    expect((await alerts(t.bob)).items.filter((a: Json) => a.kind === "commented")).toHaveLength(1);
    expect((await alerts(t.carol)).items).toEqual([]);

    // someone who was mentioned isn't also sent a plain "commented"
    await t.carol.post(`/api/tasks/${task.id}/comments`).send({ body: "@Bob", mentions: [t.ids.bob] }).expect(201);
    expect((await alerts(t.bob)).items.map((a: Json) => a.kind).sort()).toEqual(["assigned", "commented", "mentioned"]); // exactly one of each
    expect((await t.alice.get(`/api/tasks/${task.id}`)).body.comment_count).toBe(2);
  });

  it("restricts who can read, edit and delete", async () => {
    const task = await mk(t.alice, { title: "T", project_id: t.project });
    const c = (await t.carol.post(`/api/tasks/${task.id}/comments`).send({ body: "first" }).expect(201)).body;
    await t.erin.get(`/api/tasks/${task.id}/comments`).expect(404);
    expect(((await t.dave.get(`/api/tasks/${task.id}/comments`)).body as Json[]).map((x) => x.body)).toEqual(["first"]);

    await t.alice.patch(`/api/comments/${c.id}`).send({ body: "tampered" }).expect(403); // only the author edits
    const edited = (await t.carol.patch(`/api/comments/${c.id}`).send({ body: "edited" }).expect(200)).body;
    expect(edited).toMatchObject({ body: "edited" });
    expect(edited.edited_at).toBeTruthy();
    await t.erin.patch(`/api/comments/${c.id}`).send({ body: "x" }).expect(404);

    await t.dave.delete(`/api/comments/${c.id}`).expect(403);
    await t.bob.delete(`/api/comments/${c.id}`).expect(204); // an admin can moderate
    const c2 = (await t.carol.post(`/api/tasks/${task.id}/comments`).send({ body: "mine" }).expect(201)).body;
    await t.carol.delete(`/api/comments/${c2.id}`).expect(204); // authors delete their own
  });

  it("editing a comment pings only newly mentioned people", async () => {
    const task = await mk(t.alice, { title: "T", project_id: t.project });
    const c = (await t.carol.post(`/api/tasks/${task.id}/comments`).send({ body: "@Dave", mentions: [t.ids.dave] }).expect(201)).body;
    await t.carol.patch(`/api/comments/${c.id}`).send({ body: "@Dave and @Bob", mentions: [t.ids.dave, t.ids.bob] }).expect(200);
    expect((await alerts(t.dave)).items.filter((a: Json) => a.kind === "mentioned")).toHaveLength(1);
    expect((await alerts(t.bob)).items.filter((a: Json) => a.kind === "mentioned")).toHaveLength(1);
  });

  it("validates input and ignores mentions on private tasks", async () => {
    const priv = await mk(t.carol, { title: "Private" });
    const c = (await t.carol.post(`/api/tasks/${priv.id}/comments`).send({ body: "note to self", mentions: [t.ids.alice] }).expect(201)).body;
    expect(c.mentions).toEqual([]);
    expect((await alerts(t.alice)).items).toEqual([]);
    await t.carol.post(`/api/tasks/${priv.id}/comments`).send({ body: "   " }).expect(400);
    await t.alice.get(`/api/tasks/${priv.id}/comments`).expect(404);
  });
});

describe("activity feed", () => {
  it("records shared work, survives task deletion, paginates, and ignores private work", async () => {
    await mk(t.carol, { title: "Private, not logged" });
    const task = await mk(t.carol, { title: "Logged", project_id: t.project });
    await t.alice.patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200);
    await t.alice.patch(`/api/tasks/${task.id}`).send({ status: "todo" }).expect(200);
    await t.alice.delete(`/api/tasks/${task.id}`).expect(204);

    const feed = (await t.dave.get(`/api/workspaces/${t.ws}/activity?limit=100`)).body.items as Json[];
    const kinds = feed.map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(["task_deleted", "task_reopened", "task_completed", "task_created"]);
    expect(feed.find((e) => e.kind === "task_deleted")).toMatchObject({ user_id: t.ids.alice, detail: { title: "Logged" } });
    expect(feed.some((e) => e.detail.title === "Private, not logged")).toBe(false);
    expect(kinds).toContain("project_created");
    expect(kinds.filter((k) => k === "member_joined")).toHaveLength(3);

    const page1 = (await t.alice.get(`/api/workspaces/${t.ws}/activity?limit=3`)).body;
    expect(page1.items).toHaveLength(3);
    const page2 = (await t.alice.get(`/api/workspaces/${t.ws}/activity?limit=3&before=${page1.next}`)).body;
    expect(page2.items[0].id).toBeLessThan(page1.next);
    await t.erin.get(`/api/workspaces/${t.ws}/activity`).expect(404);
  });
});

describe("alerts", () => {
  it("lists newest first, counts unread, and marks only my own as read", async () => {
    await mk(t.alice, { title: "One", project_id: t.project, assignee_id: t.ids.carol });
    await mk(t.alice, { title: "Two", project_id: t.project, assignee_id: t.ids.carol });
    await mk(t.alice, { title: "Bob's", project_id: t.project, assignee_id: t.ids.bob });
    const { items, unread } = await alerts(t.carol);
    expect(unread).toBe(2);
    expect(items.map((a: Json) => a.title)).toEqual(["Two", "One"]);

    const bobsAlert = (await alerts(t.bob)).items[0].id;
    await t.carol.post("/api/alerts/read").send({ ids: [bobsAlert] }).expect(204); // not hers: ignored
    expect((await alerts(t.bob)).unread).toBe(1);

    await t.carol.post("/api/alerts/read").send({ ids: [items[0].id] }).expect(204);
    expect((await alerts(t.carol)).unread).toBe(1);
    await t.carol.post("/api/alerts/read").send({}).expect(204);
    const after = await alerts(t.carol);
    expect(after.unread).toBe(0);
    expect(after.items.every((a: Json) => a.read)).toBe(true);
  });
});

describe("people, profile and personal features alongside teams", () => {
  it("lists teammates but not strangers, and respects display names", async () => {
    const names = ((await t.carol.get("/api/people")).body as Json[]).map((p) => p.name);
    expect(names).toEqual(["Alice", "Bob", "Carol", "Dave"]);
    expect(((await t.erin.get("/api/people")).body as Json[]).map((p) => p.name)).toEqual(["Erin"]);

    const me = (await t.erin.patch("/api/auth/me").send({ name: "Erin Q." }).expect(200)).body;
    expect(me.name).toBe("Erin Q.");
    expect(((await t.alice.get("/api/people")).body as Json[]).some((p) => p.name === "Erin Q.")).toBe(false);

    const noName = request.agent(t.app);
    await noName.post("/api/auth/register").send({ email: "gina.park@example.com", password: "password123" }).expect(201);
    expect((await noName.get("/api/auth/me")).body.name).toBe("gina.park"); // falls back to the email's local part
  });

  it("keeps dashboard numbers about my work, not the whole team's", async () => {
    await mk(t.alice, { title: "Alice's, unassigned", project_id: t.project });
    await mk(t.alice, { title: "Assigned to Carol", project_id: t.project, assignee_id: t.ids.carol, due_at: "2020-01-01T00:00:00.000Z" });
    await mk(t.carol, { title: "Carol's own" });
    const stats = (await t.carol.get("/api/stats")).body;
    expect(stats.open_total).toBe(2); // the assigned one and her private one
    expect(stats.overdue).toBe(1);
    expect((await t.alice.get("/api/stats")).body.open_total).toBe(2); // her two shared ones, not Carol's private task
    expect((await t.dave.get("/api/stats")).body.open_total).toBe(0);
  });

  it("sends reminders to the assignee (or the author when unassigned), only while they can see the task", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    const assigned = await mk(t.alice, { title: "For Carol", project_id: t.project, assignee_id: t.ids.carol, remind_at: past });
    const unassigned = await mk(t.alice, { title: "For Alice", project_id: t.project, remind_at: past });
    expect(fireDueReminders(t.db, new Date())).toBe(2);
    expect(((await t.carol.get("/api/notifications")).body as Json[]).map((n) => n.title)).toEqual(["For Carol"]);
    expect(((await t.alice.get("/api/notifications")).body as Json[]).map((n) => n.title)).toEqual(["For Alice"]);
    expect((await t.bob.get("/api/notifications")).body).toEqual([]);
    await t.carol.post(`/api/notifications/${assigned.id}/ack`).expect(204);
    await t.erin.post(`/api/notifications/${unassigned.id}/ack`).expect(404);
  });

  it("exports only private data and imports as private", async () => {
    await mk(t.carol, { title: "Shared", project_id: t.project });
    await mk(t.carol, { title: "Mine" });
    await t.carol.post("/api/projects").send({ name: "Private project" }).expect(201);
    const exported = (await t.carol.get("/api/export")).body;
    expect(exported.tasks.map((x: Json) => x.title)).toEqual(["Mine"]);
    expect(exported.projects.map((p: Json) => p.name)).toEqual(["Private project"]);
    expect((await t.carol.get("/api/export.csv")).text).not.toContain("Shared");
    const res = (await t.carol.post("/api/import?format=csv").set("Content-Type", "text/csv").send("title,project\nImported,Launch").expect(201)).body;
    expect(res.projects).toBe(1); // a new private "Launch", not the workspace's
    expect(((await t.alice.get("/api/tasks")).body as Json[]).map((x) => x.title)).toEqual(["Shared"]);
  });

  it("personal time tracking works on shared tasks and totals include teammates", async () => {
    const task = await mk(t.alice, { title: "Shared timing", project_id: t.project });
    await t.carol.post(`/api/tasks/${task.id}/timer/start`).expect(201);
    await t.carol.post("/api/timer/stop").expect(200);
    t.db.prepare("UPDATE time_entries SET started_at = datetime('now', '-30 minutes')").run();
    expect((await t.bob.get(`/api/tasks/${task.id}`)).body.tracked_min).toBeGreaterThanOrEqual(29);
    expect((await t.bob.get("/api/timer")).body).toBeNull(); // timers are per person
  });
});
