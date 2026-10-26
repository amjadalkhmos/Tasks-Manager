import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

type Agent = ReturnType<typeof request.agent>;

async function login(app: ReturnType<typeof createApp>, email = "a@example.com"): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "password123" }).expect(201);
  return agent;
}

const mk = async (agent: Agent, body: object) => (await agent.post("/api/tasks").send(body).expect(201)).body;

let app: ReturnType<typeof createApp>;
let agent: Agent;
beforeEach(async () => {
  app = createApp(openDb(":memory:"), "test-secret");
  agent = await login(app);
});

describe("nesting", () => {
  it("rolls progress up across all descendants and rejects cycles", async () => {
    const root = await mk(agent, { title: "root" });
    const child = await mk(agent, { title: "child", parent_id: root.id });
    const grandchild = await mk(agent, { title: "grandchild", parent_id: child.id });
    await mk(agent, { title: "sibling", parent_id: root.id });

    await agent.post(`/api/tasks/${grandchild.id}/complete`).expect(200);
    const got = (await agent.get(`/api/tasks/${root.id}`)).body;
    expect(got.subtasks_total).toBe(3);
    expect(got.subtasks_done).toBe(1);

    await agent.patch(`/api/tasks/${root.id}`).send({ parent_id: grandchild.id }).expect(400);
    await agent.patch(`/api/tasks/${root.id}`).send({ parent_id: root.id }).expect(400);
    await agent.patch(`/api/tasks/${grandchild.id}`).send({ parent_id: root.id }).expect(200);
  });
});

describe("dependencies", () => {
  it("blocks completion until prerequisites are done, and rejects cycles", async () => {
    const a = await mk(agent, { title: "a" });
    const b = await mk(agent, { title: "b" });
    const c = await mk(agent, { title: "c" });

    const blocked = (await agent.post(`/api/tasks/${b.id}/deps`).send({ blocked_by_id: a.id }).expect(201)).body;
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked_by).toEqual([a.id]);
    await agent.post(`/api/tasks/${b.id}/complete`).expect(409);
    await agent.patch(`/api/tasks/${b.id}`).send({ status: "done" }).expect(409);

    await agent.post(`/api/tasks/${c.id}/deps`).send({ blocked_by_id: b.id }).expect(201);
    await agent.post(`/api/tasks/${a.id}/deps`).send({ blocked_by_id: c.id }).expect(400); // a→c→b→a
    await agent.post(`/api/tasks/${a.id}/deps`).send({ blocked_by_id: a.id }).expect(400);

    await agent.post(`/api/tasks/${a.id}/complete`).expect(200);
    expect((await agent.get(`/api/tasks/${b.id}`)).body.blocked).toBe(false);
    await agent.post(`/api/tasks/${b.id}/complete`).expect(200);

    const freed = (await agent.delete(`/api/tasks/${c.id}/deps/${b.id}`).expect(200)).body;
    expect(freed.blocked_by).toEqual([]);
  });

  it("will not link another user's task", async () => {
    const mine = await mk(agent, { title: "mine" });
    const other = await login(app, "b@example.com");
    const theirs = await mk(other, { title: "theirs" });
    await agent.post(`/api/tasks/${mine.id}/deps`).send({ blocked_by_id: theirs.id }).expect(400);
    await other.post(`/api/tasks/${mine.id}/deps`).send({ blocked_by_id: theirs.id }).expect(404);
  });
});

describe("checklists", () => {
  it("supports add, toggle, delete and shows counts on the task", async () => {
    const t = await mk(agent, { title: "trip" });
    const item = (await agent.post(`/api/tasks/${t.id}/checklist`).send({ text: "passport" }).expect(201)).body;
    await agent.post(`/api/tasks/${t.id}/checklist`).send({ text: "tickets" }).expect(201);
    await agent.patch(`/api/checklist/${item.id}`).send({ done: true }).expect(200);

    const list = (await agent.get(`/api/tasks/${t.id}/checklist`)).body;
    expect(list.map((i: { text: string; done: boolean }) => [i.text, i.done])).toEqual([
      ["passport", true],
      ["tickets", false],
    ]);
    const got = (await agent.get(`/api/tasks/${t.id}`)).body;
    expect([got.checklist_done, got.checklist_total]).toEqual([1, 2]);

    const other = await login(app, "b@example.com");
    await other.patch(`/api/checklist/${item.id}`).send({ done: false }).expect(404);
    await agent.delete(`/api/checklist/${item.id}`).expect(204);
  });
});

describe("ordering", () => {
  it("lists by position when asked, with new tasks appended", async () => {
    const a = await mk(agent, { title: "a" });
    const b = await mk(agent, { title: "b" });
    await agent.patch(`/api/tasks/${b.id}`).send({ position: a.position - 1 }).expect(200);
    const titles = (await agent.get("/api/tasks?sort=position")).body.map((t: { title: string }) => t.title);
    expect(titles).toEqual(["b", "a"]);
  });
});

describe("saved filters", () => {
  it("stores, lists and deletes per user", async () => {
    const f = (
      await agent.post("/api/filters").send({ name: "Urgent work", query: { tag: "work", priority: 3 } }).expect(201)
    ).body;
    expect((await agent.get("/api/filters")).body).toEqual([f]);
    const other = await login(app, "b@example.com");
    expect((await other.get("/api/filters")).body).toEqual([]);
    await other.delete(`/api/filters/${f.id}`).expect(404);
    await agent.delete(`/api/filters/${f.id}`).expect(204);
  });
});

describe("time tracking and stats", () => {
  it("keeps one running timer and reports tracked time and stats", async () => {
    const a = await mk(agent, { title: "a" });
    const b = await mk(agent, { title: "b" });
    await agent.post(`/api/tasks/${a.id}/timer/start`).expect(201);
    expect((await agent.get("/api/timer")).body.task_id).toBe(a.id);

    const started = (await agent.post(`/api/tasks/${b.id}/timer/start`).expect(201)).body;
    expect(started.timer_running).toBe(true);
    expect((await agent.get(`/api/tasks/${a.id}`)).body.timer_running).toBe(false);

    await agent.post("/api/timer/stop").expect(200);
    expect((await agent.get("/api/timer")).body).toBeNull();

    await agent.post(`/api/tasks/${a.id}/complete`).expect(200);
    const stats = (await agent.get("/api/stats?offset=0")).body;
    expect(stats.completed_by_day).toHaveLength(14);
    expect(stats.completed_by_day.at(-1).count).toBe(1);
    expect(stats.completed_week).toBe(1);
    expect(stats.open_total).toBe(1);
    expect(stats.time_by_project).toHaveLength(1);
    await agent.get("/api/stats?offset=abc").expect(400);
  });
});
