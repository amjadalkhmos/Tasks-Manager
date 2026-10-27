import type { Express } from "express";
import { z } from "zod";
import { FORBIDDEN, projectAccess, roleIn } from "./access.js";
import type { Queryable } from "./db.js";
import { displayName } from "./dialect.js";
import { HttpError, parseId } from "./http-error.js";
import { requireSales, salesScope, assignableOwners } from "./sales-access.js";
import { nowIso, workspaceIdSchema, type SalesDeps } from "./sales-shared.js";
import { parseStamp } from "./sla.js";
import { effectiveStatuses } from "./statuses.js";

const STAGE_KINDS = ["open", "won", "lost"] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #2563eb");

/** What a new pipeline starts with. Deals enter after a lead has been qualified, so the first stage is already a real opportunity. */
const DEFAULT_STAGES: { name: string; color: string; probability: number; kind: (typeof STAGE_KINDS)[number] }[] = [
  { name: "Qualified", color: "#64748b", probability: 20, kind: "open" },
  { name: "Proposal", color: "#2563eb", probability: 40, kind: "open" },
  { name: "Negotiation", color: "#a855f7", probability: 70, kind: "open" },
  { name: "Won", color: "#16a34a", probability: 100, kind: "won" },
  { name: "Lost", color: "#dc2626", probability: 0, kind: "lost" },
];

async function createPipeline(q: Queryable, workspaceId: number, name: string, currency: string, stages = DEFAULT_STAGES): Promise<number> {
  const position = (await q.get<{ n: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM pipelines WHERE workspace_id = ?", workspaceId))!.n;
  const id = await q.insert("INSERT INTO pipelines (workspace_id, name, currency, position) VALUES (?, ?, ?, ?)", workspaceId, name, currency, position);
  for (const [i, s] of stages.entries()) {
    await q.run("INSERT INTO pipeline_stages (pipeline_id, name, color, position, probability, kind) VALUES (?, ?, ?, ?, ?, ?)", id, s.name, s.color, i, s.probability, s.kind);
  }
  return id;
}

/** When someone leaves a workspace their records go back to the unassigned inbox, and the grants that involved them are dropped. */
export async function releaseSalesRecords(q: Queryable, workspaceId: number, userId: number): Promise<void> {
  for (const table of ["leads", "accounts", "contacts", "deals"]) await q.run(`UPDATE ${table} SET owner_id = NULL WHERE workspace_id = ? AND owner_id = ?`, workspaceId, userId);
  await q.run("DELETE FROM sales_access WHERE workspace_id = ? AND (user_id = ? OR owner_id = ?)", workspaceId, userId, userId);
}

export function registerSalesSetup(app: Express, { db, auth, uid }: SalesDeps) {
  const D = db.dialect;
  const NAME = displayName(D, "u");

  const managerOf = async (rawWs: unknown, userId: number) => {
    const wid = workspaceIdSchema.parse(rawWs);
    const scope = await requireSales(db, wid, userId);
    if (!scope.manager) throw FORBIDDEN();
    return wid;
  };

  const pipelinesWithStages = async (wid: number) => {
    const pipelines = await db.all<any>("SELECT id, name, currency, position FROM pipelines WHERE workspace_id = ? ORDER BY position, id", wid);
    const stages = await db.all<any>(
      "SELECT s.id, s.pipeline_id, s.name, s.color, s.position, s.probability, s.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.workspace_id = ? ORDER BY s.position, s.id", wid,
    );
    return pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
  };

  // ---------- who am I in Sales ----------
  /** The workspaces where Sales is switched on for the caller; the sidebar uses this to decide whether to show it. */
  app.get("/api/sales/workspaces", auth, async (req, res) => {
    const me = uid(req);
    const rows = await db.all<{ id: number; name: string }>("SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.name, w.id", me);
    const out: { id: number; name: string; manager: boolean }[] = [];
    for (const w of rows) {
      const s = await salesScope(db, w.id, me);
      if (s?.enabled) out.push({ id: w.id, name: w.name, manager: s.manager });
    }
    res.json(out);
  });

  app.get("/api/sales/me", auth, async (req, res) => {
    const me = uid(req);
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await salesScope(db, wid, me);
    if (!scope) throw new HttpError(404, "Workspace not found");
    if (!scope.enabled) return void res.json({ enabled: false });

    if (!(await db.get("SELECT 1 FROM pipelines WHERE workspace_id = ?", wid))) {
      await db.tx(async (t) => {
        if (!(await t.get("SELECT 1 FROM pipelines WHERE workspace_id = ?", wid))) await createPipeline(t, wid, "Sales", "USD");
      });
    }
    const members = await db.all<{ id: number; name: string; role: string }>(
      `SELECT u.id, ${NAME} AS name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY LOWER(${NAME}), u.id`, wid,
    );
    const mine = assignableOwners(scope);
    res.json({
      enabled: true,
      manager: scope.manager,
      role: scope.role,
      user_id: me,
      /** Who the caller can see, and at what level. */
      owners: scope.manager ? members.map((m) => ({ id: m.id, name: m.name, level: "edit" })) : members.filter((m) => scope.owners.has(m.id)).map((m) => ({ id: m.id, name: m.name, level: scope.owners.get(m.id) })),
      unassigned: scope.manager ? "edit" : scope.unassigned,
      /** Who the caller may give records to. */
      assignable: { owners: scope.manager ? members.map((m) => ({ id: m.id, name: m.name })) : members.filter((m) => mine.ids.includes(m.id)).map((m) => ({ id: m.id, name: m.name })), unassigned: mine.unassigned },
      pipelines: await pipelinesWithStages(wid),
    });
  });

  // ---------- grants ----------
  app.get("/api/workspaces/:id/sales-access", auth, async (req, res) => {
    const wid = await managerOf(parseId(req.params.id, "Workspace not found"), uid(req));
    const members = await db.all<{ user_id: number; name: string; email: string; role: string }>(
      `SELECT u.id AS user_id, ${NAME} AS name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY LOWER(${NAME}), u.id`, wid,
    );
    const rows = await db.all<{ user_id: number; owner_id: number | null; level: string }>("SELECT user_id, owner_id, level FROM sales_access WHERE workspace_id = ?", wid);
    res.json(
      members.map((m) => {
        const mine = rows.filter((r) => r.user_id === m.user_id);
        return {
          ...m,
          everything: m.role === "owner" || m.role === "admin",
          enabled: mine.length > 0,
          grants: mine.filter((r) => r.owner_id !== null && r.owner_id !== m.user_id).map((r) => ({ owner_id: r.owner_id, level: r.level })),
          unassigned: mine.find((r) => r.owner_id === null)?.level ?? null,
        };
      }),
    );
  });

  app.put("/api/workspaces/:id/sales-access/:userId", auth, async (req, res) => {
    const wid = await managerOf(parseId(req.params.id, "Workspace not found"), uid(req));
    const target = parseId(req.params.userId, "Member not found");
    const b = z.object({
      enabled: z.boolean(),
      grants: z.array(z.object({ owner_id: z.number().int().positive(), level: z.enum(["view", "edit"]) })).max(500).default([]),
      unassigned: z.enum(["view", "edit"]).nullable().default(null),
    }).parse(req.body);
    const role = await roleIn(db, wid, target);
    if (!role) throw new HttpError(404, "Member not found");
    if (role === "owner" || role === "admin") throw new HttpError(400, "Workspace owners and admins can already see everything in Sales");
    const owners = new Set<number>();
    for (const g of b.grants) {
      if (!(await roleIn(db, wid, g.owner_id))) throw new HttpError(400, "You can only grant records owned by members of this workspace");
      owners.add(g.owner_id);
    }
    await db.tx(async (t) => {
      await t.run("DELETE FROM sales_access WHERE workspace_id = ? AND user_id = ?", wid, target);
      if (!b.enabled) return;
      // The person's own records are implicit; the row for themselves is what marks Sales as switched on.
      await t.run("INSERT INTO sales_access (workspace_id, user_id, owner_id, level) VALUES (?, ?, ?, 'edit')", wid, target, target);
      for (const g of b.grants) if (g.owner_id !== target) await t.run("INSERT INTO sales_access (workspace_id, user_id, owner_id, level) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", wid, target, g.owner_id, g.level);
      if (b.unassigned) await t.run("INSERT INTO sales_access (workspace_id, user_id, owner_id, level) VALUES (?, ?, NULL, ?)", wid, target, b.unassigned);
    });
    res.json({ user_id: target, enabled: b.enabled });
  });

  // ---------- pipelines and their stages ----------
  app.post("/api/sales/pipelines", auth, async (req, res) => {
    const b = z.object({ workspace_id: workspaceIdSchema, name: z.string().trim().min(1).max(100), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("USD") }).parse(req.body);
    await managerOf(b.workspace_id, uid(req));
    const id = await db.tx((t) => createPipeline(t, b.workspace_id, b.name, b.currency));
    res.status(201).json({ id });
  });

  const pipelineFor = async (rawId: unknown, userId: number) => {
    const p = await db.get<{ id: number; workspace_id: number }>("SELECT id, workspace_id FROM pipelines WHERE id = ?", parseId(rawId, "Pipeline not found"));
    if (!p) throw new HttpError(404, "Pipeline not found");
    const scope = await requireSales(db, p.workspace_id, userId).catch(() => { throw new HttpError(404, "Pipeline not found"); });
    if (!scope.manager) throw FORBIDDEN();
    return p;
  };

  app.patch("/api/sales/pipelines/:id", auth, async (req, res) => {
    const p = await pipelineFor(req.params.id, uid(req));
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional() }).parse(req.body);
    await db.run("UPDATE pipelines SET name = COALESCE(?, name), currency = COALESCE(?, currency) WHERE id = ?", b.name ?? null, b.currency ?? null, p.id);
    res.json({ id: p.id });
  });

  app.delete("/api/sales/pipelines/:id", auth, async (req, res) => {
    const p = await pipelineFor(req.params.id, uid(req));
    if (Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deals WHERE pipeline_id = ?", p.id))!.n) > 0) throw new HttpError(409, "This pipeline still has deals. Move or delete them first.");
    if (Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pipelines WHERE workspace_id = ?", p.workspace_id))!.n) <= 1) throw new HttpError(409, "Keep at least one pipeline");
    await db.run("DELETE FROM pipelines WHERE id = ?", p.id);
    res.status(204).end();
  });

  const stageFields = {
    name: z.string().trim().min(1).max(60),
    color,
    probability: z.number().int().min(0).max(100),
    kind: z.enum(STAGE_KINDS),
  };
  const stageBody = z.object(stageFields).partial().required({ name: true }).transform((b) => ({ ...b, color: b.color ?? "#64748b", probability: b.probability ?? 0, kind: b.kind ?? ("open" as const) }));
  const stagePatch = z.object(stageFields).partial();

  app.post("/api/sales/pipelines/:id/stages", auth, async (req, res) => {
    const p = await pipelineFor(req.params.id, uid(req));
    const b = stageBody.parse(req.body);
    // New open stages slot in before the closing ones, so Won and Lost stay at the end.
    const closing = (await db.get<{ n: number | null }>("SELECT MIN(position) AS n FROM pipeline_stages WHERE pipeline_id = ? AND kind <> 'open'", p.id))?.n;
    const position = b.kind === "open" && closing !== null && closing !== undefined ? closing : ((await db.get<{ n: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM pipeline_stages WHERE pipeline_id = ?", p.id))!.n);
    const id = await db.tx(async (t) => {
      if (b.kind === "open" && closing !== null && closing !== undefined) await t.run("UPDATE pipeline_stages SET position = position + 1 WHERE pipeline_id = ? AND position >= ?", p.id, position);
      return t.insert("INSERT INTO pipeline_stages (pipeline_id, name, color, position, probability, kind) VALUES (?, ?, ?, ?, ?, ?)", p.id, b.name, b.color, position, b.kind === "won" ? 100 : b.kind === "lost" ? 0 : b.probability, b.kind);
    });
    res.status(201).json({ id });
  });

  const stageFor = async (rawId: unknown, userId: number) => {
    const s = await db.get<{ id: number; pipeline_id: number; kind: string; name: string; workspace_id: number }>(
      "SELECT s.id, s.pipeline_id, s.kind, s.name, p.workspace_id FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ?", parseId(rawId, "Stage not found"),
    );
    if (!s) throw new HttpError(404, "Stage not found");
    await pipelineFor(s.pipeline_id, userId);
    return s;
  };
  const keepsEveryKind = async (pipelineId: number, excludingStage: number, becoming?: string) => {
    const kinds = (await db.all<{ kind: string }>("SELECT kind FROM pipeline_stages WHERE pipeline_id = ? AND id <> ?", pipelineId, excludingStage)).map((r) => r.kind);
    if (becoming) kinds.push(becoming);
    return STAGE_KINDS.every((k) => kinds.includes(k));
  };

  app.patch("/api/sales/stages/:id", auth, async (req, res) => {
    const s = await stageFor(req.params.id, uid(req));
    const b = stagePatch.parse(req.body);
    if (b.kind && b.kind !== s.kind && !(await keepsEveryKind(s.pipeline_id, s.id, b.kind))) throw new HttpError(409, "A pipeline needs at least one open, one won and one lost stage");
    const kind = b.kind ?? s.kind;
    await db.tx(async (t) => {
      await t.run(
        "UPDATE pipeline_stages SET name = COALESCE(?, name), color = COALESCE(?, color), probability = COALESCE(?, probability), kind = ? WHERE id = ?",
        b.name ?? null, b.color ?? null, kind === "won" ? 100 : kind === "lost" ? 0 : (b.probability ?? null), kind, s.id,
      );
      if (b.kind && b.kind !== s.kind) {
        // Deals sitting in the stage follow its new meaning: closing it closes them, opening it reopens them.
        if (kind === "open") await t.run("UPDATE deals SET closed_at = NULL, lost_reason = '' WHERE stage_id = ?", s.id);
        else await t.run("UPDATE deals SET closed_at = COALESCE(closed_at, ?) WHERE stage_id = ?", nowIso(), s.id);
      }
    });
    res.json({ id: s.id });
  });

  app.put("/api/sales/pipelines/:id/stage-order", auth, async (req, res) => {
    const p = await pipelineFor(req.params.id, uid(req));
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) }).parse(req.body);
    const have = (await db.all<{ id: number }>("SELECT id FROM pipeline_stages WHERE pipeline_id = ?", p.id)).map((r) => r.id);
    if (ids.length !== have.length || !have.every((i) => ids.includes(i))) throw new HttpError(400, "List every stage of the pipeline exactly once");
    await db.tx(async (t) => {
      for (const [i, id] of ids.entries()) await t.run("UPDATE pipeline_stages SET position = ? WHERE id = ?", i, id);
    });
    res.json({ ids });
  });

  app.delete("/api/sales/stages/:id", auth, async (req, res) => {
    const s = await stageFor(req.params.id, uid(req));
    if (!(await keepsEveryKind(s.pipeline_id, s.id))) throw new HttpError(409, "A pipeline needs at least one open, one won and one lost stage");
    const inStage = Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?", s.id))!.n);
    const moveTo = req.query.move_to ? Number(req.query.move_to) : null;
    if (inStage > 0 && moveTo === null) throw new HttpError(409, `${inStage} deal${inStage === 1 ? " is" : "s are"} in this stage. Choose where they should go.`);
    await db.tx(async (t) => {
      if (moveTo !== null) {
        const target = await t.get<{ id: number; kind: string }>("SELECT id, kind FROM pipeline_stages WHERE id = ? AND pipeline_id = ? AND id <> ?", moveTo, s.pipeline_id, s.id);
        if (!target) throw new HttpError(400, "Pick another stage of this pipeline");
        if (target.kind === "open") await t.run("UPDATE deals SET stage_id = ?, closed_at = NULL, stage_changed_at = ? WHERE stage_id = ?", target.id, nowIso(), s.id);
        else await t.run("UPDATE deals SET stage_id = ?, closed_at = COALESCE(closed_at, ?), stage_changed_at = ? WHERE stage_id = ?", target.id, nowIso(), nowIso(), s.id);
      }
      await t.run("DELETE FROM pipeline_stages WHERE id = ?", s.id);
    });
    res.status(204).end();
  });

  // ---------- moving an old pipeline project into Sales ----------
  app.post("/api/projects/:id/convert-to-sales", auth, async (req, res) => {
    const me = uid(req);
    const pa = await projectAccess(db, me, parseId(req.params.id, "Project not found"));
    if (!pa) throw new HttpError(404, "Project not found");
    if (pa.workspaceId === null) throw new HttpError(400, "Sales belongs to a workspace. Move the project into one first.");
    if (!pa.canManage) throw FORBIDDEN();
    const wid = pa.workspaceId;
    const project = await db.get<{ id: number; name: string; type: string; currency: string }>("SELECT id, name, type, currency FROM projects WHERE id = ?", pa.id);
    if (project?.type !== "pipeline") throw new HttpError(400, "Only a sales pipeline project can be moved to Sales");

    const result = await db.tx(async (t) => {
      const statuses = await effectiveStatuses(t, project.id, wid);
      const stages = statuses.length
        ? statuses.map((s) => ({
            name: s.name, color: s.color,
            kind: (s.category === "done" ? (s.probability === 0 ? "lost" : "won") : "open") as (typeof STAGE_KINDS)[number],
            probability: s.probability ?? 0, statusId: s.id as number | null,
          }))
        : [
            { name: "Open", color: "#64748b", kind: "open" as const, probability: 20, statusId: null },
            { name: "Won", color: "#16a34a", kind: "won" as const, probability: 100, statusId: null },
            { name: "Lost", color: "#dc2626", kind: "lost" as const, probability: 0, statusId: null },
          ];
      for (const [kind, name, c] of [["open", "Open", "#64748b"], ["won", "Won", "#16a34a"], ["lost", "Lost", "#dc2626"]] as const) {
        if (!stages.some((s) => s.kind === kind)) stages.push({ name, color: c, kind, probability: kind === "won" ? 100 : 0, statusId: null });
      }
      stages.sort((a, b) => STAGE_KINDS.indexOf(a.kind) - STAGE_KINDS.indexOf(b.kind)); // open stages keep their order; Won and Lost go last
      const pipelineId = await createPipeline(t, wid, project.name, project.currency, stages);
      const created = await t.all<{ id: number; name: string }>("SELECT id, name FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id", pipelineId);
      const stageOf = new Map<number, number>();
      stages.forEach((s, i) => s.statusId !== null && stageOf.set(s.statusId, created[i]!.id));
      const firstOf = (kind: string) => created[stages.findIndex((s) => s.kind === kind)]!.id;

      const tasks = await t.all<any>("SELECT * FROM tasks WHERE project_id = ? AND parent_id IS NULL ORDER BY id", project.id);
      let unowned = 0;
      for (const task of tasks) {
        const wanted: number | null = task.assignee_id ?? task.user_id;
        const ownerId = wanted !== null && (await roleIn(t, wid, wanted)) ? wanted : null;
        if (ownerId === null) unowned += 1;
        const stageId = (task.status_id !== null ? stageOf.get(task.status_id) : undefined) ?? firstOf(task.status === "done" ? "won" : "open");
        const kind = stages[created.findIndex((c) => c.id === stageId)]!.kind;
        const dealId = await t.insert(
          `INSERT INTO deals (workspace_id, pipeline_id, stage_id, owner_id, title, value, expected_close, closed_at, notes, created_by, created_at, stage_changed_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          wid, pipelineId, stageId, ownerId, task.title, task.value ?? null, task.due_at ? String(task.due_at).slice(0, 10) : null,
          kind === "open" ? null : (task.completed_at ?? nowIso()), task.notes ?? "", task.user_id, task.created_at ? new Date(parseStamp(task.created_at)).toISOString() : nowIso(), nowIso(), nowIso(),
        );
        for (const c of await t.all<any>("SELECT user_id, body, created_at FROM comments WHERE task_id = ? ORDER BY id", task.id)) {
          await t.run("INSERT INTO sales_activities (workspace_id, user_id, kind, body, occurred_at, deal_id) VALUES (?, ?, 'note', ?, ?, ?)", wid, c.user_id, c.body, c.created_at, dealId);
        }
      }
      await t.run("DELETE FROM tasks WHERE project_id = ?", project.id);
      // Shelved, and no longer a pipeline: what it held is in Sales now.
      await t.run("UPDATE projects SET stage = 'archived', type = 'initiative' WHERE id = ?", project.id);
      await t.run("INSERT INTO project_updates (project_id, user_id, kind, stage, body) VALUES (?, ?, 'stage', 'archived', ?)", project.id, me, "Moved to Sales");
      return { pipeline_id: pipelineId, deals: tasks.length, without_owner: unowned };
    });
    res.json(result);
  });
}
