import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openPglite } from "./db-pglite.js";
import { openSqlite } from "./db-sqlite.js";
import { copySqliteToPostgres } from "./migrate-sqlite-to-postgres.js";
import { backend } from "./test-db.js";

process.env.BCRYPT_ROUNDS = "4";

// This test builds its own SQLite source and PostgreSQL target, so it runs once, not once per backend.
describe.runIf(backend === "sqlite")("copying a SQLite database to PostgreSQL", () => {
  it("moves every table, keeps ids and relationships, and leaves the app behaving identically", async () => {
    const source = await openSqlite(":memory:");
    const target = await openPglite();
    const SECRET = "migration-secret";
    const old = createApp(source, SECRET);

    // --- build a realistic history through the real API ---
    const alice = request.agent(old);
    const aliceId = (await alice.post("/api/auth/register").send({ email: "alice@example.com", password: "password123", name: "Alice" }).expect(201)).body.id;
    const bob = request.agent(old);
    await bob.post("/api/auth/register").send({ email: "bob@example.com", password: "password123" }).expect(201);

    const ws = (await alice.post("/api/workspaces").send({ name: "Acme" }).expect(201)).body.id;
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: "bob@example.com", role: "member" }).expect(201);
    const invite = (await bob.get("/api/invites")).body[0];
    await bob.post(`/api/invites/${invite.id}/accept`).expect(200);
    await alice.post(`/api/workspaces/${ws}/invites`).send({ email: "pending@example.com", role: "viewer" }).expect(201);
    const project = (await alice.post("/api/projects").send({ name: "Launch", workspace_id: ws }).expect(201)).body.id;

    // statuses (workspace-wide and per-project), life cycle, milestones and updates
    await alice.post("/api/statuses").send({ workspace_id: ws, name: "In review", category: "doing" }).expect(201);
    await alice.post("/api/statuses").send({ project_id: project, name: "Blocked upstream", category: "todo" }).expect(201);
    await alice.patch(`/api/projects/${project}`).send({ description: "Ship it", start_date: "2026-01-05", target_date: "2026-03-31" }).expect(200);
    await alice.post(`/api/projects/${project}/milestones`).send({ name: "Beta", due_date: "2026-02-01" }).expect(201);
    await alice.post(`/api/projects/${project}/updates`).send({ health: "at_risk", body: "Vendor delay" }).expect(201);
    await alice.post(`/api/projects/${project}/stage`).send({ stage: "on_hold", note: "Budget" }).expect(200);
    await alice.post(`/api/projects/${project}/stage`).send({ stage: "active" }).expect(200);

    const first = (await alice.post("/api/tasks").send({ title: "Planned first, nested under a later task", tags: ["a", "b"] }).expect(201)).body;
    const later = (await alice.post("/api/tasks").send({ title: "Created later", project_id: project, assignee_id: (await bob.get("/api/auth/me")).body.id, due_at: "2026-03-04T10:00:00.000Z", recurrence: { freq: "weekly", interval: 1 }, estimate_min: 90 }).expect(201)).body;
    // the first task is moved under a task with a HIGHER id, which a naive in-order copy would reject
    const privateParent = (await alice.post("/api/tasks").send({ title: "Private parent" }).expect(201)).body;
    await alice.patch(`/api/tasks/${first.id}`).send({ parent_id: privateParent.id }).expect(200);
    await alice.post(`/api/tasks/${later.id}/checklist`).send({ text: "step one" }).expect(201);
    await alice.post(`/api/tasks/${later.id}/comments`).send({ body: "hello @Bob", mentions: [(await bob.get("/api/auth/me")).body.id] }).expect(201);
    const dep = (await alice.post("/api/tasks").send({ title: "Depends on first" }).expect(201)).body;
    await alice.post(`/api/tasks/${dep.id}/deps`).send({ blocked_by_id: first.id }).expect(201);
    await alice.post("/api/filters").send({ name: "Mine", query: { tag: "a" } }).expect(201);
    // a shared meeting linked to a shared task, and a private one linked to a private task
    const sharedMeeting = (await alice.post("/api/meetings").send({ title: "Planning", starts_at: "2026-03-04T10:00:00.000Z", workspace_id: ws, task_ids: [later.id], location: "Room 1", url: "https://meet.example.com/x" }).expect(201)).body;
    await alice.post("/api/meetings").send({ title: "Dentist", starts_at: "2026-03-05T09:00:00.000Z", task_ids: [first.id] }).expect(201);
    // sales: a grant, an account with a contact, a lead, a deal with an activity and a follow-up, and a public form
    const bobId = (await bob.get("/api/auth/me")).body.id;
    await alice.put(`/api/workspaces/${ws}/sales-access/${bobId}`).send({ enabled: true, grants: [{ owner_id: aliceId, level: "view" }] }).expect(200);
    const pipelineId = (await alice.get("/api/sales/me").query({ workspace_id: ws })).body.pipelines[0].id;
    const acct = (await alice.post("/api/sales/accounts").send({ workspace_id: ws, name: "Acme Corp", website: "acme.test" }).expect(201)).body.id;
    await alice.post("/api/sales/contacts").send({ workspace_id: ws, name: "Pat", email: "pat@acme.test", account_id: acct }).expect(201);
    await alice.post("/api/sales/leads").send({ workspace_id: ws, name: "Lee", email: "lee@x.test" }).expect(201);
    const dealId = (await alice.post("/api/sales/deals").send({ workspace_id: ws, title: "Rollout", account_id: acct, pipeline_id: pipelineId, value: 900 }).expect(201)).body.id;
    await alice.post("/api/sales/activities").send({ deal_id: dealId, kind: "call", subject: "Intro" }).expect(201);
    await alice.post("/api/sales/followups").send({ deal_id: dealId, title: "Send quote" }).expect(201);
    await alice.post("/api/sales/forms").send({ workspace_id: ws, name: "Web" }).expect(201);
    await alice.post(`/api/tasks/${first.id}/timer/start`).expect(201);
    await alice.post("/api/timer/stop").expect(200);
    await alice.post(`/api/tasks/${later.id}/complete`).expect(200); // spawns the next occurrence

    const snapshot = async (app: ReturnType<typeof createApp>, cookies: string[]) => {
      const get = async (path: string, who: string) => (await request(app).get(path).set("Cookie", who)).body;
      const out: Record<string, unknown> = {};
      for (const [name, cookie] of [["alice", cookies[0]], ["bob", cookies[1]]] as const) {
        out[name] = {
          tasks: await get("/api/tasks", cookie),
          projects: await get("/api/projects", cookie),
          tags: await get("/api/tags", cookie),
          workspaces: await get("/api/workspaces", cookie),
          workspace: await get(`/api/workspaces/${ws}`, cookie),
          people: await get("/api/people", cookie),
          alerts: await get("/api/alerts", cookie),
          filters: await get("/api/filters", cookie),
          activity: await get(`/api/workspaces/${ws}/activity?limit=100`, cookie),
          comments: await get(`/api/tasks/${later.id}/comments`, cookie),
          checklist: await get(`/api/tasks/${later.id}/checklist`, cookie),
          meetings: await get("/api/meetings", cookie),
          statuses: await get("/api/statuses", cookie),
          portfolio: await get("/api/portfolio", cookie),
          overview: await get(`/api/projects/${project}/overview`, cookie),
          salesMe: await get(`/api/sales/me?workspace_id=${ws}`, cookie),
          salesLeads: await get(`/api/sales/leads?workspace_id=${ws}`, cookie),
          salesAccounts: await get(`/api/sales/accounts?workspace_id=${ws}`, cookie),
          salesDeals: await get(`/api/sales/deals?workspace_id=${ws}`, cookie),
          salesDeal: await get(`/api/sales/deals/${dealId}`, cookie),
          salesForecast: await get(`/api/sales/forecast?workspace_id=${ws}`, cookie),
          taskMeetings: await get(`/api/tasks/${later.id}/meetings`, cookie),
          stats: await get("/api/stats", cookie),
          export: name === "alice" ? await get("/api/export", cookie) : null,
        };
      }
      return out;
    };
    // sessions are signed cookies, so the same cookies are valid against the copied database
    const cookiesOf = async (agent: ReturnType<typeof request.agent>, email: string) =>
      request(old).post("/api/auth/login").send({ email, password: "password123" }).then((r) => (r.headers["set-cookie"] as unknown as string[])[0].split(";")[0]);
    const cookies = [await cookiesOf(alice, "alice@example.com"), await cookiesOf(bob, "bob@example.com")];

    const before = await snapshot(old, cookies);

    // --- copy ---
    const report = await copySqliteToPostgres(source, target);
    expect(report.copied.users).toBe(2);
    expect(report.copied.tasks).toBeGreaterThanOrEqual(5);
    expect(report.copied.comments).toBe(1);
    expect(report.copied.workspace_invites).toBe(1);
    expect(report.copied.meetings).toBe(2);
    expect(report.copied.meeting_tasks).toBe(2);
    expect(report.copied.statuses).toBe(8); // 3 defaults + "In review" for the workspace, 3 defaults + "Blocked upstream" for the project
    expect(report.copied.milestones).toBe(1);
    expect(report.copied.project_updates).toBe(3);
    expect(report.copied).toMatchObject({ pipelines: 1, pipeline_stages: 5, accounts: 1, contacts: 1, leads: 1, deals: 1, sales_activities: 2, sales_access: 2, lead_forms: 1 }); // "Created in Qualified" and the call
    expect(sharedMeeting.task_ids).toEqual([later.id]);

    const migrated = createApp(target, SECRET);
    const after = await snapshot(migrated, cookies);
    // exported_at is "now" and differs; everything else, ids included, must match exactly
    const strip = (s: any) => ({ ...s, alice: { ...s.alice, export: { ...s.alice.export, exported_at: null } } });
    expect(strip(after)).toEqual(strip(before));

    // the new database keeps working: new rows get fresh ids after the copied ones, not colliding ones
    const fresh = await request(migrated).post("/api/tasks").set("Cookie", cookies[0]).send({ title: "Created after the move" }).expect(201);
    const maxBefore = Math.max(...((before.alice as any).tasks as { id: number }[]).map((t) => t.id));
    expect(fresh.body.id).toBeGreaterThan(maxBefore);
    expect(aliceId).toBeGreaterThan(0);
    const newUser = await request(migrated).post("/api/auth/register").send({ email: "carol@example.com", password: "password123" }).expect(201);
    expect(newUser.body.id).toBeGreaterThan(2);

    // copying into a database that already has accounts is refused
    await expect(copySqliteToPostgres(source, target)).rejects.toThrow(/already has accounts/);
    // and only SQLite -> PostgreSQL is supported
    await expect(copySqliteToPostgres(target, source)).rejects.toThrow(/SQLite to PostgreSQL/);
  }, 30_000);
});
