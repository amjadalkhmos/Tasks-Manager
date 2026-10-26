import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { fireDueReminders } from "./reminders.js";
import { nextOccurrence } from "./recurrence.js";

function setup() {
  const db = openDb(":memory:");
  return { db, app: createApp(db, "test-secret") };
}

async function login(app: ReturnType<typeof createApp>, email = "a@example.com") {
  const agent = request.agent(app);
  await agent.post("/api/auth/register").send({ email, password: "password123" }).expect(201);
  return agent;
}

describe("auth", () => {
  it("rejects unauthenticated access and duplicate emails", async () => {
    const { app } = setup();
    await request(app).get("/api/tasks").expect(401);
    await login(app);
    await request(app).post("/api/auth/register").send({ email: "a@example.com", password: "password123" }).expect(409);
  });

  it("logs in with correct password only", async () => {
    const { app } = setup();
    await login(app);
    await request(app).post("/api/auth/login").send({ email: "a@example.com", password: "wrong-password" }).expect(401);
    await request(app).post("/api/auth/login").send({ email: "a@example.com", password: "password123" }).expect(200);
  });
});

describe("tasks", () => {
  let app: ReturnType<typeof createApp>;
  let agent: ReturnType<typeof request.agent>;
  beforeEach(async () => {
    ({ app } = setup());
    agent = await login(app);
  });

  it("creates tasks with tags, subtasks and filters", async () => {
    const proj = (await agent.post("/api/projects").send({ name: "Home" }).expect(201)).body;
    const parent = (
      await agent.post("/api/tasks").send({ title: "Move", project_id: proj.id, priority: 2, tags: ["Urgent", "urgent"] }).expect(201)
    ).body;
    expect(parent.tags).toEqual(["urgent"]);
    await agent.post("/api/tasks").send({ title: "Pack", parent_id: parent.id }).expect(201);

    expect((await agent.get("/api/tasks?parent_id=null")).body).toHaveLength(1);
    expect((await agent.get(`/api/tasks?parent_id=${parent.id}`)).body).toHaveLength(1);
    expect((await agent.get("/api/tasks?tag=urgent")).body).toHaveLength(1);
    expect((await agent.get("/api/tasks?q=pack")).body).toHaveLength(1);
  });

  it("isolates data between users", async () => {
    const task = (await agent.post("/api/tasks").send({ title: "Secret" }).expect(201)).body;
    const other = await login(app, "b@example.com");
    await other.get(`/api/tasks/${task.id}`).expect(404);
    await other.delete(`/api/tasks/${task.id}`).expect(404);
    await other.post("/api/tasks").send({ title: "x", parent_id: task.id }).expect(400);
  });

  it("validates input", async () => {
    await agent.post("/api/tasks").send({ title: "" }).expect(400);
    await agent.post("/api/tasks").send({ title: "x", priority: 9 }).expect(400);
  });

  it("spawns the next occurrence when a recurring task completes", async () => {
    const task = (
      await agent
        .post("/api/tasks")
        .send({
          title: "Water plants",
          due_at: "2026-01-01T09:00:00.000Z",
          remind_at: "2026-01-01T08:00:00.000Z",
          recurrence: { freq: "weekly", interval: 1 },
          tags: ["home"],
        })
        .expect(201)
    ).body;
    const { body } = await agent.post(`/api/tasks/${task.id}/complete`).expect(200);
    expect(body.completed.status).toBe("done");
    expect(body.next.due_at).toBe("2026-01-08T09:00:00.000Z");
    expect(body.next.remind_at).toBe("2026-01-08T08:00:00.000Z");
    expect(body.next.tags).toEqual(["home"]);
    await agent.post(`/api/tasks/${task.id}/complete`).expect(409);
  });
});

describe("reminders", () => {
  it("fires due reminders once and exposes them as notifications", async () => {
    const { app, db } = setup();
    const agent = await login(app);
    await agent.post("/api/tasks").send({ title: "Call", remind_at: "2026-01-01T10:00:00.000Z" }).expect(201);
    await agent.post("/api/tasks").send({ title: "Later", remind_at: "2027-01-01T10:00:00.000Z" }).expect(201);

    expect(fireDueReminders(db, new Date("2026-06-01T00:00:00Z"))).toBe(1);
    expect(fireDueReminders(db, new Date("2026-06-01T00:01:00Z"))).toBe(0);

    const { body } = await agent.get("/api/notifications").expect(200);
    expect(body.map((n: { title: string }) => n.title)).toEqual(["Call"]);
    await agent.post(`/api/notifications/${body[0].id}/ack`).expect(204);
    expect((await agent.get("/api/notifications")).body).toEqual([]);
  });
});

describe("nextOccurrence", () => {
  it("handles daily, weekday lists and month-end clamping", () => {
    expect(nextOccurrence("2026-01-01T00:00:00.000Z", { freq: "daily", interval: 3 })).toBe("2026-01-04T00:00:00.000Z");
    // Thu 2026-01-01 with Mon/Wed → next Monday
    expect(nextOccurrence("2026-01-01T00:00:00.000Z", { freq: "weekly", interval: 1, weekdays: [1, 3] })).toBe(
      "2026-01-05T00:00:00.000Z",
    );
    expect(nextOccurrence("2026-01-31T00:00:00.000Z", { freq: "monthly", interval: 1 })).toBe("2026-02-28T00:00:00.000Z");
  });
});
