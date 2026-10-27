import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { FORBIDDEN, projectAccess, roleIn, visibleArgs, visibleTasksSql, type ProjectAccess } from "./access.js";
import { inChunks, marks, type DB, type Queryable } from "./db.js";
import { countWhere, displayName, epoch } from "./dialect.js";
import { userName } from "./events.js";
import { HttpError, parseId } from "./http-error.js";
import { forecast, type Stage as ForecastStage } from "./forecast.js";
import { minutesBetween, parseStamp, sla } from "./sla.js";
import { standing, type MilestoneLite, type TaskLite } from "./standing.js";
import { effectiveStatuses } from "./statuses.js";

/** What a milestone carries beyond what its standing needs. */
interface MilestoneExtra {
  description: string;
  criteria: string;
  owner_id: number | null;
  owner_name: string | null;
  signed_off_at: string | null;
  sign_off_note: string;
  marker: "payment" | "deliverable" | null;
  amount: number | null;
  invoiced_at: string | null;
  /** How many times the forecast date has been moved. */
  slips: number;
}

export const STAGES = ["planning", "active", "on_hold", "completed", "archived"] as const;
export type Stage = (typeof STAGES)[number];

/** The project life cycle: where each stage may go next. Archived is a shelf, and restoring brings a project back to active. */
export const TRANSITIONS: Record<Stage, Stage[]> = {
  planning: ["active", "archived"],
  active: ["on_hold", "completed", "archived"],
  on_hold: ["active", "archived"],
  completed: ["active", "archived"],
  archived: ["active"],
};

const HEALTH = ["on_track", "at_risk", "off_track"] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-03-31").refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date");

const stageBody = z.object({ stage: z.enum(STAGES), note: z.string().trim().max(2000).optional(), force: z.boolean().optional() });
const updateBody = z.object({ health: z.enum(HEALTH), body: z.string().trim().max(5000).default("") });

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

export function registerProjectManagement(app: Express, { db, auth, uid }: Deps) {
  const D = db.dialect;

  async function readable(userId: number, rawId: unknown): Promise<ProjectAccess> {
    const pa = await projectAccess(db, userId, parseId(rawId, "Project not found"));
    if (!pa) throw new HttpError(404, "Project not found");
    return pa;
  }
  /** Same rule as editing a project: private owner, workspace admins, or the member who made it. */
  const canEditProject = (pa: ProjectAccess, userId: number) => pa.workspaceId === null || pa.canManage || (pa.canWrite && pa.creatorId === userId);

  /** How each project stands (see standing.ts), plus the team's own latest health rating. Top-level tasks only. */
  async function standings(q: Queryable, projects: { id: number; stage: string; start_date: string | null; target_date: string | null }[]) {
    const ids = projects.map((p) => p.id);
    const [tasks, milestones, deps, latest] = await Promise.all([
      inChunks(ids, (m, a) =>
        q.all<TaskLite & { project_id: number }>(`SELECT project_id, status, due_at, estimate_min, milestone_id FROM tasks WHERE parent_id IS NULL AND project_id IN (${m})`, ...a),
      ),
      inChunks(ids, (m, a) =>
        q.all<MilestoneLite & MilestoneExtra & { project_id: number; position: number }>(
          `SELECT ms.id, ms.project_id, ms.name, ms.due_date, ms.completed_at, ms.position, ms.description, ms.criteria, ms.owner_id, ${displayName(D, "o")} AS owner_name,
                  ms.baseline_date, ms.outcome, ms.signed_off_at, ms.sign_off_note, ms.marker, ms.amount, ms.invoiced_at,
                  (SELECT COUNT(*) FROM milestone_moves x WHERE x.milestone_id = ms.id AND x.from_date IS NOT NULL) AS slips
           FROM milestones ms LEFT JOIN users o ON o.id = ms.owner_id
           WHERE ms.project_id IN (${m}) ORDER BY ms.due_date IS NULL, ms.due_date, ms.position, ms.id`, ...a,
        ),
      ),
      inChunks(ids, (m, a) =>
        q.all<{ milestone_id: number; depends_on_id: number }>(
          `SELECT d.milestone_id, d.depends_on_id FROM milestone_deps d JOIN milestones ms ON ms.id = d.milestone_id WHERE ms.project_id IN (${m})`, ...a,
        ),
      ),
      inChunks(ids, (m, a) =>
        q.all<{ project_id: number; health: string; created_at: string }>(
          `SELECT u.project_id, u.health, u.created_at FROM project_updates u
           WHERE u.kind = 'update' AND u.project_id IN (${m}) AND u.id = (SELECT MAX(x.id) FROM project_updates x WHERE x.project_id = u.project_id AND x.kind = 'update')`, ...a,
        ),
      ),
    ]);
    const byProject = <T extends { project_id: number }>(rows: T[]) => {
      const m = new Map<number, T[]>();
      for (const r of rows) m.set(r.project_id, [...(m.get(r.project_id) ?? []), r]);
      return m;
    };
    const t = byProject(tasks);
    const dependsOn = new Map<number, number[]>();
    for (const d of deps) dependsOn.set(d.milestone_id, [...(dependsOn.get(d.milestone_id) ?? []), d.depends_on_id]);
    const ms = byProject(milestones.map((m) => ({ ...m, depends_on: dependsOn.get(m.id) ?? [] })));
    const l = new Map(latest.map((r) => [r.project_id, r]));
    return (p: { id: number; stage: string; start_date: string | null; target_date: string | null }) => ({
      ...standing(p, t.get(p.id) ?? [], ms.get(p.id) ?? []),
      health: (l.get(p.id)?.health ?? null) as (typeof HEALTH)[number] | null,
      last_update_at: l.get(p.id)?.created_at ?? null,
    });
  }

  // ---------- portfolio: every project I can see, with where it stands ----------
  app.get("/api/portfolio", auth, async (req, res) => {
    const me = uid(req);
    const projects = await db.all<{
      id: number; name: string; color: string; workspace_id: number | null; type: string; description: string; stage: Stage; lead_id: number | null; start_date: string | null; target_date: string | null;
    }>(
      `SELECT p.id, p.name, p.color, p.workspace_id, p.type, p.description, p.stage, p.lead_id, p.start_date, p.target_date FROM projects p
       WHERE (p.workspace_id IS NULL AND p.user_id = ?) OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?)
       ORDER BY p.name, p.id`,
      me, me,
    );
    const stats = await standings(db, projects);
    res.json(projects.map((p) => {
      const { milestones: _detail, ...summary } = stats(p);
      return { ...p, ...summary };
    }));
  });

  // ---------- what needs attention ----------
  const SHOWN = 50;
  /**
   * One page for "what should I look at": projects drifting off plan, overdue and blocked work, and (for people who
   * manage a workspace) unassigned work and who is carrying how much. Everyone sees their own work; admins and owners
   * also see everything in the workspaces they manage.
   */
  app.get("/api/attention", auth, async (req, res) => {
    const me = uid(req);
    const nowIso = new Date().toISOString();
    const managed = (await db.all<{ workspace_id: number }>("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role IN ('owner','admin')", me)).map((r) => r.workspace_id);
    const mine = `${visibleTasksSql("t")} AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND t.user_id = ?)
       OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role IN ('owner','admin')))`;
    const mineArgs = [...visibleArgs(me), me, me, me];
    const live = "(p.id IS NULL OR p.stage NOT IN ('archived','completed'))";
    const cols = "t.id, t.title, t.project_id, t.due_at, t.assignee_id, t.status, p.name AS project_name, p.workspace_id";
    const list = async (extra: string, args: unknown[], order: string) => {
      const base = `FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${mine} AND t.status != 'done' AND ${live} AND ${extra}`;
      const [items, total] = await Promise.all([
        db.all(`SELECT ${cols} ${base} ORDER BY ${order} LIMIT ${SHOWN}`, ...mineArgs, ...args),
        db.get<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, ...mineArgs, ...args),
      ]);
      return { total: total!.n, items };
    };

    const [overdue, blocked] = await Promise.all([
      list("t.due_at IS NOT NULL AND t.due_at < ?", [nowIso], "t.due_at, t.id"),
      list("EXISTS (SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.blocked_by_id WHERE d.task_id = t.id AND b.status != 'done')", [], "t.id"),
    ]);

    let unassigned: Awaited<ReturnType<typeof list>> = { total: 0, items: [] };
    let workload: { workspace_id: number; assignee_id: number | null; name: string | null; open: number; overdue: number }[] = [];
    if (managed.length) {
      const m = managed.map(() => "?").join(",");
      const base = `FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.workspace_id IN (${m}) AND t.parent_id IS NULL AND t.status != 'done' AND p.stage NOT IN ('archived','completed')`;
      const [items, total, load] = await Promise.all([
        db.all(`SELECT ${cols} ${base} AND t.assignee_id IS NULL ORDER BY t.due_at IS NULL, t.due_at, t.id LIMIT ${SHOWN}`, ...managed),
        db.get<{ n: number }>(`SELECT COUNT(*) AS n ${base} AND t.assignee_id IS NULL`, ...managed),
        db.all<{ workspace_id: number; assignee_id: number | null; open: number; overdue: number }>(
          `SELECT p.workspace_id, t.assignee_id, COUNT(*) AS open, ${countWhere("t.due_at IS NOT NULL AND t.due_at < ?")} AS overdue ${base} GROUP BY p.workspace_id, t.assignee_id`,
          nowIso, ...managed,
        ),
      ]);
      unassigned = { total: total!.n, items };
      const ids = [...new Set(load.map((r) => r.assignee_id).filter((x): x is number => x !== null))];
      const names = new Map((await inChunks(ids, (mk, a) => db.all<{ id: number; name: string }>(`SELECT u.id, ${displayName(D, "u")} AS name FROM users u WHERE u.id IN (${mk})`, ...a))).map((r) => [r.id, r.name]));
      workload = load
        .map((r) => ({ ...r, name: r.assignee_id === null ? null : (names.get(r.assignee_id) ?? "A former member") }))
        .sort((a, b) => b.open - a.open);
    }

    // Projects that are active and either rated at risk by the team or flagged by the numbers.
    const projects = await db.all<{ id: number; name: string; color: string; workspace_id: number | null; stage: string; start_date: string | null; target_date: string | null }>(
      `SELECT p.id, p.name, p.color, p.workspace_id, p.stage, p.start_date, p.target_date FROM projects p
       WHERE p.stage = 'active' AND ((p.workspace_id IS NULL AND p.user_id = ?) OR p.workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))`,
      me, me,
    );
    const stats = await standings(db, projects);
    const flagged = projects
      .map((p) => {
        const { milestones: _m, ...s } = stats(p);
        return { ...p, ...s };
      })
      .filter((p) => p.signals.length > 0 || p.health === "at_risk" || p.health === "off_track")
      .sort((a, b) => Number(b.health === "off_track" || b.suggested_health === "off_track") - Number(a.health === "off_track" || a.suggested_health === "off_track") || b.signals.length - a.signals.length);

    res.json({ is_manager: managed.length > 0, projects: flagged, overdue, blocked, unassigned, workload });
  });

  // ---------- life cycle ----------
  app.post("/api/projects/:id/stage", auth, async (req, res) => {
    const me = uid(req);
    const b = stageBody.parse(req.body);
    const pa = await readable(me, req.params.id);
    if (!canEditProject(pa, me)) throw FORBIDDEN();
    const from = pa.stage as Stage;
    if (b.stage === from) throw new HttpError(409, `The project is already ${from.replace("_", " ")}`);
    if (!TRANSITIONS[from].includes(b.stage)) {
      throw new HttpError(409, `A ${from.replace("_", " ")} project can't go straight to ${b.stage.replace("_", " ")}. It can go to: ${TRANSITIONS[from].map((s) => s.replace("_", " ")).join(", ")}.`);
    }
    await db.tx(async (t) => {
      if (b.stage === "completed" && !b.force) {
        const open = (await t.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND parent_id IS NULL AND status != 'done'", pa.id))!.n;
        if (open > 0) throw new HttpError(409, `${open} task${open === 1 ? " is" : "s are"} still open. Finish them, or complete the project anyway.`);
      }
      await t.run("UPDATE projects SET stage = ? WHERE id = ?", b.stage, pa.id);
      await t.run("INSERT INTO project_updates (project_id, user_id, kind, stage, body) VALUES (?, ?, 'stage', ?, ?)", pa.id, me, b.stage, b.note ?? "");
    });
    res.json(await db.get("SELECT id, name, color, workspace_id, type, description, stage, lead_id, start_date, target_date, currency, first_response_hours, resolution_hours FROM projects WHERE id = ?", pa.id));
  });

  // ---------- health updates ----------
  app.post("/api/projects/:id/updates", auth, async (req, res) => {
    const me = uid(req);
    const b = updateBody.parse(req.body);
    const pa = await readable(me, req.params.id);
    if (!pa.canWrite) throw FORBIDDEN();
    const id = await db.insert("INSERT INTO project_updates (project_id, user_id, kind, health, body) VALUES (?, ?, 'update', ?, ?)", pa.id, me, b.health, b.body);
    res.status(201).json(await db.get("SELECT id, kind, stage, health, body, created_at, user_id FROM project_updates WHERE id = ?", id));
  });

  app.delete("/api/projects/:id/updates/:updateId", auth, async (req, res) => {
    const me = uid(req);
    const pa = await readable(me, req.params.id);
    const u = await db.get<{ id: number; user_id: number; kind: string }>("SELECT id, user_id, kind FROM project_updates WHERE id = ? AND project_id = ?", parseId(req.params.updateId, "Update not found"), pa.id);
    if (!u || u.kind !== "update") throw new HttpError(404, "Update not found");
    if (!(u.user_id === me || canEditProject(pa, me))) throw FORBIDDEN();
    await db.run("DELETE FROM project_updates WHERE id = ?", u.id);
    res.status(204).end();
  });

  // ---------- milestones ----------
  // A milestone is a dated checkpoint. Its date is a forecast that can move (each move is kept, with a reason, next to the
  // baseline it started with); whether it was achieved is a decision for the project's lead or a manager.
  const MS_COLS = `ms.id, ms.project_id, ms.name, ms.due_date, ms.completed_at, ms.position, ms.description, ms.criteria, ms.owner_id, ${displayName(D, "o")} AS owner_name,
    ms.baseline_date, ms.outcome, ms.signed_off_at, ms.signed_off_by, ms.sign_off_note, ms.marker, ms.amount, ms.invoiced_at`;
  const milestoneRow = async (id: number) => {
    const row = await db.get<Record<string, any>>(`SELECT ${MS_COLS} FROM milestones ms LEFT JOIN users o ON o.id = ms.owner_id WHERE ms.id = ?`, id);
    if (!row) return row;
    const depends_on = (await db.all<{ depends_on_id: number }>("SELECT depends_on_id FROM milestone_deps WHERE milestone_id = ? ORDER BY depends_on_id", id)).map((d) => d.depends_on_id);
    return { ...row, depends_on };
  };

  /** The project's lead, a manager, or (in a private project) its owner may decide a milestone's outcome and invoice it. */
  const canSignOff = async (pa: ProjectAccess, userId: number): Promise<boolean> => {
    if (pa.workspaceId === null) return pa.creatorId === userId;
    if (pa.canManage) return true;
    return (await db.get<{ lead_id: number | null }>("SELECT lead_id FROM projects WHERE id = ?", pa.id))?.lead_id === userId;
  };

  const marker = z.enum(["payment", "deliverable"]).nullable();
  const amount = z.number().min(0).max(1e12).nullable();
  const createBody = z.object({
    name: z.string().trim().min(1).max(200),
    due_date: day.nullable().optional(),
    description: z.string().trim().max(5000).optional(),
    criteria: z.string().trim().max(5000).optional(),
    owner_id: z.number().int().positive().nullable().optional(),
    marker: marker.optional(),
    amount: amount.optional(),
    depends_on: z.array(z.number().int().positive()).max(50).optional(),
  });
  const editBody = createBody.partial().extend({
    /** Why the forecast date moved; kept in the milestone's history. */
    reason: z.string().trim().max(500).optional(),
    /** Only someone who can sign off may re-baseline. */
    baseline_date: day.nullable().optional(),
  });

  /** The owner of a milestone must be someone on the project. */
  const assertMilestoneOwner = async (pa: ProjectAccess, ownerId: number) => {
    const ok = pa.workspaceId === null ? ownerId === pa.creatorId : !!(await roleIn(db, pa.workspaceId, ownerId));
    if (!ok) throw new HttpError(400, "The owner has to be someone on this project");
  };

  /** Replaces a milestone's prerequisites, refusing anything outside the project, itself, or a loop. */
  const setDependencies = async (t: Queryable, milestoneId: number, projectId: number, ids: number[]) => {
    const unique = [...new Set(ids)];
    if (unique.includes(milestoneId)) throw new HttpError(400, "A milestone can't depend on itself");
    if (unique.length) {
      const found = await t.all<{ id: number }>(`SELECT id FROM milestones WHERE project_id = ? AND id IN (${marks(unique.length)})`, projectId, ...unique);
      if (found.length !== unique.length) throw new HttpError(400, "A milestone can only depend on others in the same project");
    }
    // Following the chain from each prerequisite must never lead back here.
    const edges = await t.all<{ milestone_id: number; depends_on_id: number }>(
      "SELECT d.milestone_id, d.depends_on_id FROM milestone_deps d JOIN milestones m ON m.id = d.milestone_id WHERE m.project_id = ? AND d.milestone_id <> ?", projectId, milestoneId,
    );
    const seen = new Set<number>();
    const walk = (id: number): boolean => {
      if (id === milestoneId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return edges.filter((e) => e.milestone_id === id).some((e) => walk(e.depends_on_id));
    };
    if (unique.some(walk)) throw new HttpError(400, "That would make the milestones wait on each other in a circle");
    await t.run("DELETE FROM milestone_deps WHERE milestone_id = ?", milestoneId);
    for (const id of unique) await t.run("INSERT INTO milestone_deps (milestone_id, depends_on_id) VALUES (?, ?)", milestoneId, id);
  };

  app.post("/api/projects/:id/milestones", auth, async (req, res) => {
    const b = createBody.parse(req.body);
    const pa = await readable(uid(req), req.params.id);
    if (!pa.canWrite) throw FORBIDDEN();
    if (b.owner_id) await assertMilestoneOwner(pa, b.owner_id);
    const id = await db.tx(async (t) => {
      const created = await t.insert(
        `INSERT INTO milestones (project_id, name, due_date, baseline_date, description, criteria, owner_id, marker, amount, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM milestones WHERE project_id = ?))`,
        pa.id, b.name, b.due_date ?? null, b.due_date ?? null, b.description ?? "", b.criteria ?? "", b.owner_id ?? null, b.marker ?? null, b.marker === "payment" ? (b.amount ?? null) : null, pa.id,
      );
      if (b.depends_on?.length) await setDependencies(t, created, pa.id, b.depends_on);
      return created;
    });
    res.status(201).json(await milestoneRow(id));
  });

  const loadMilestone = async (userId: number, rawId: unknown, need: "read" | "write" | "sign" = "write") => {
    const m = await db.get<{ id: number; project_id: number; due_date: string | null; baseline_date: string | null; outcome: string | null; marker: string | null; name: string }>(
      "SELECT id, project_id, due_date, baseline_date, outcome, marker, name FROM milestones WHERE id = ?", parseId(rawId, "Milestone not found"),
    );
    if (!m) throw new HttpError(404, "Milestone not found");
    const pa = await projectAccess(db, userId, m.project_id);
    if (!pa) throw new HttpError(404, "Milestone not found");
    if (need !== "read" && !pa.canWrite) throw FORBIDDEN();
    const signer = need === "sign" || need === "read" ? await canSignOff(pa, userId) : false;
    if (need === "sign" && !signer) throw new HttpError(403, "Only the project's lead or a manager can decide a milestone's outcome");
    return { ...m, pa, signer };
  };

  app.get("/api/milestones/:id", auth, async (req, res) => {
    const m = await loadMilestone(uid(req), req.params.id, "read");
    const [row, moves, tasks, dependents, siblings] = await Promise.all([
      milestoneRow(m.id),
      db.all(
        `SELECT x.id, x.from_date, x.to_date, x.reason, x.created_at, ${displayName(D, "u")} AS user_name FROM milestone_moves x LEFT JOIN users u ON u.id = x.user_id WHERE x.milestone_id = ? ORDER BY x.id DESC`, m.id,
      ),
      db.all(`SELECT t.id, t.title, t.status, t.due_at FROM tasks t WHERE t.milestone_id = ? AND t.parent_id IS NULL ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at, t.id LIMIT 200`, m.id),
      db.all("SELECT d.milestone_id AS id, ms.name FROM milestone_deps d JOIN milestones ms ON ms.id = d.milestone_id WHERE d.depends_on_id = ? ORDER BY ms.id", m.id),
      db.all("SELECT id, name, outcome FROM milestones WHERE project_id = ? AND id <> ? ORDER BY due_date IS NULL, due_date, position, id", m.project_id, m.id),
    ]);
    res.json({ ...row, moves, tasks, dependents, others: siblings, can_write: m.pa.canWrite, can_sign_off: m.signer });
  });

  app.patch("/api/milestones/:id", auth, async (req, res) => {
    const me = uid(req);
    const b = editBody.parse(req.body);
    const m = await loadMilestone(me, req.params.id, b.baseline_date !== undefined ? "sign" : "write");
    if (m.outcome !== null && (b.due_date !== undefined || b.depends_on !== undefined)) throw new HttpError(409, "This milestone has been decided. Reopen it to change its date or what it waits on.");
    if (b.owner_id) await assertMilestoneOwner(m.pa, b.owner_id);
    await db.tx(async (t) => {
      const sets: string[] = [];
      const args: unknown[] = [];
      const put = (col: string, v: unknown) => (sets.push(`${col} = ?`), args.push(v));
      if (b.name !== undefined) put("name", b.name);
      if (b.description !== undefined) put("description", b.description);
      if (b.criteria !== undefined) put("criteria", b.criteria);
      if (b.owner_id !== undefined) put("owner_id", b.owner_id);
      if (b.marker !== undefined) {
        put("marker", b.marker);
        if (b.marker !== "payment") put("amount", null);
      }
      if (b.amount !== undefined && (b.marker === "payment" || (b.marker === undefined && m.marker === "payment"))) put("amount", b.amount);
      if (b.baseline_date !== undefined) put("baseline_date", b.baseline_date);
      if (b.due_date !== undefined && b.due_date !== m.due_date) {
        put("due_date", b.due_date);
        // The first date ever given is the promise.
        if (m.baseline_date === null && b.baseline_date === undefined) put("baseline_date", b.due_date);
        await t.run("INSERT INTO milestone_moves (milestone_id, user_id, from_date, to_date, reason) VALUES (?, ?, ?, ?, ?)", m.id, me, m.due_date, b.due_date, b.reason ?? "");
      }
      if (sets.length) await t.run(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`, ...args, m.id);
      if (b.depends_on !== undefined) await setDependencies(t, m.id, m.project_id, b.depends_on);
    });
    res.json(await milestoneRow(m.id));
  });

  /** Deciding a milestone: achieved or missed, by the project's lead or a manager, with a note. */
  app.post("/api/milestones/:id/sign-off", auth, async (req, res) => {
    const me = uid(req);
    const b = z.object({ outcome: z.enum(["achieved", "missed"]), note: z.string().trim().max(2000).optional(), force: z.boolean().optional() }).parse(req.body);
    const m = await loadMilestone(me, req.params.id, "sign");
    if (m.outcome !== null) throw new HttpError(409, "This milestone has already been decided. Reopen it first.");
    if (b.outcome === "achieved" && !b.force) {
      const waiting = await db.all<{ name: string }>(
        "SELECT ms.name FROM milestone_deps d JOIN milestones ms ON ms.id = d.depends_on_id WHERE d.milestone_id = ? AND (ms.outcome IS NULL OR ms.outcome <> 'achieved') ORDER BY ms.id", m.id,
      );
      if (waiting.length) throw new HttpError(409, `It waits on ${waiting.map((w) => `“${w.name}”`).join(", ")}, which ${waiting.length === 1 ? "hasn't" : "haven't"} been achieved.`);
    }
    const now = new Date().toISOString();
    await db.run(
      "UPDATE milestones SET outcome = ?, completed_at = ?, signed_off_at = ?, signed_off_by = ?, sign_off_note = ? WHERE id = ?",
      b.outcome, b.outcome === "achieved" ? now : null, now, me, b.note ?? "", m.id,
    );
    res.json(await milestoneRow(m.id));
  });

  app.post("/api/milestones/:id/reopen", auth, async (req, res) => {
    const m = await loadMilestone(uid(req), req.params.id, "sign");
    if (m.outcome === null) throw new HttpError(409, "This milestone is still open");
    await db.run("UPDATE milestones SET outcome = NULL, completed_at = NULL, signed_off_at = NULL, signed_off_by = NULL, sign_off_note = '', invoiced_at = NULL WHERE id = ?", m.id);
    res.json(await milestoneRow(m.id));
  });

  /** For a payment milestone that was achieved: record that the invoice has gone out (or take it back). */
  app.post("/api/milestones/:id/invoiced", auth, async (req, res) => {
    const { invoiced } = z.object({ invoiced: z.boolean() }).parse(req.body);
    const m = await loadMilestone(uid(req), req.params.id, "sign");
    if (m.marker !== "payment") throw new HttpError(409, "Only a payment milestone is invoiced");
    if (m.outcome !== "achieved") throw new HttpError(409, "A payment milestone is invoiced once it has been achieved");
    await db.run("UPDATE milestones SET invoiced_at = ? WHERE id = ?", invoiced ? new Date().toISOString() : null, m.id);
    res.json(await milestoneRow(m.id));
  });

  app.delete("/api/milestones/:id", auth, async (req, res) => {
    const m = await loadMilestone(uid(req), req.params.id);
    await db.run("DELETE FROM milestones WHERE id = ?", m.id);
    res.status(204).end();
  });

  // ---------- one project's management view ----------
  app.get("/api/projects/:id/overview", auth, async (req, res) => {
    const me = uid(req);
    const pa = await readable(me, req.params.id);
    const nowIso = new Date().toISOString();
    const { intake_token: intakeToken, ...project } = (await db.get<Record<string, any>>("SELECT id, name, color, workspace_id, type, description, stage, lead_id, start_date, target_date, currency, first_response_hours, resolution_hours, intake_token FROM projects WHERE id = ?", pa.id))!;
    const { milestones, ...stats } = (await standings(db, [project as { id: number; stage: string; start_date: string | null; target_date: string | null }]))(project as { id: number; stage: string; start_date: string | null; target_date: string | null });

    const [tasks, assignees, time, updates, statuses, blocked] = await Promise.all([
      db.all<{ status: string; status_id: number | null; value: number | null; due_at: string | null; priority: number; ticket_no: number | null; created_at: string; first_response_at: string | null; completed_at: string | null }>(
        "SELECT status, status_id, value, due_at, priority, ticket_no, created_at, first_response_at, completed_at FROM tasks WHERE project_id = ? AND parent_id IS NULL", pa.id,
      ),
      db.all<{ assignee_id: number | null; n: number }>("SELECT assignee_id, COUNT(*) AS n FROM tasks WHERE project_id = ? AND parent_id IS NULL AND status != 'done' GROUP BY assignee_id", pa.id),
      db.get<{ tracked: number; estimate: number }>(
        `SELECT COALESCE((SELECT SUM(${epoch(D, "COALESCE(e.ended_at, ?)")} - ${epoch(D, "e.started_at")}) FROM time_entries e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ?), 0) AS tracked,
                COALESCE((SELECT SUM(estimate_min) FROM tasks WHERE project_id = ? AND parent_id IS NULL), 0) AS estimate`,
        nowIso, pa.id, pa.id,
      ),
      db.all<{ id: number; user_id: number; kind: string; stage: string | null; health: string | null; body: string; created_at: string }>(
        "SELECT id, user_id, kind, stage, health, body, created_at FROM project_updates WHERE project_id = ? ORDER BY id DESC LIMIT 30", pa.id,
      ),
      effectiveStatuses(db, pa.id, pa.workspaceId),
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks t WHERE t.project_id = ? AND t.parent_id IS NULL AND t.status != 'done'
           AND EXISTS (SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.blocked_by_id WHERE d.task_id = t.id AND b.status != 'done')`,
        pa.id,
      ),
    ]);

    // Tasks without an explicit status count under the first status of their category.
    const firstOf = (cat: string) => statuses.find((s) => s.category === cat)?.id ?? null;
    const byStatus = statuses.length
      ? statuses.map((s) => ({
          id: s.id, name: s.name, color: s.color, category: s.category,
          count: tasks.filter((t) => (t.status_id === s.id) || (t.status_id === null && t.status === s.category && firstOf(s.category) === s.id)).length,
        }))
      : [
          { id: null, name: "To do", color: "#64748b", category: "todo", count: tasks.filter((t) => t.status === "todo").length },
          { id: null, name: "Doing", color: "#2563eb", category: "doing", count: tasks.filter((t) => t.status === "doing").length },
          { id: null, name: "Done", color: "#16a34a", category: "done", count: tasks.filter((t) => t.status === "done").length },
        ];

    // Pipelines get a forecast from their deals' values and each stage's chance of winning.
    let pipeline: (ReturnType<typeof forecast> & { currency: string }) | null = null;
    if (project.type === "pipeline") {
      const stages: ForecastStage[] = statuses.length
        ? statuses.map((s) => ({ id: s.id, name: s.name, color: s.color, category: s.category, probability: s.probability }))
        : [
            { id: null, name: "To do", color: "#64748b", category: "todo", probability: null },
            { id: null, name: "Doing", color: "#2563eb", category: "doing", probability: null },
            { id: null, name: "Done", color: "#16a34a", category: "done", probability: null },
          ];
      pipeline = { currency: project.currency, ...forecast(tasks, stages) };
    }

    // Support desks get their queue's health: how many tickets are waiting, and how the service targets are going.
    let support: Record<string, unknown> | null = null;
    if (project.type === "support") {
      const now = new Date();
      const weekAgo = now.getTime() - 7 * 86_400_000;
      const tickets = tasks.filter((t) => t.ticket_no !== null);
      const open = tickets.filter((t) => t.status !== "done");
      const targets = { first_response_hours: project.first_response_hours as number | null, resolution_hours: project.resolution_hours as number | null };
      const clocks = open.map((t) => sla(t, targets, now));
      const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
      support = {
        open: open.length,
        unanswered: open.filter((t) => !t.first_response_at).length,
        response_breached: clocks.filter((c) => c?.response?.state === "breached").length,
        resolution_breached: clocks.filter((c) => c?.resolution?.state === "breached").length,
        at_risk: clocks.filter((c) => c?.response?.state === "at_risk" || c?.resolution?.state === "at_risk").length,
        avg_first_response_min: avg(tickets.filter((t) => t.first_response_at).map((t) => minutesBetween(t.created_at, t.first_response_at!))),
        avg_resolution_min: avg(tickets.filter((t) => t.status === "done" && t.completed_at).map((t) => minutesBetween(t.created_at, t.completed_at!))),
        created_7d: tickets.filter((t) => parseStamp(t.created_at) >= weekAgo).length,
        resolved_7d: tickets.filter((t) => t.status === "done" && t.completed_at && parseStamp(t.completed_at) >= weekAgo).length,
        by_priority: [0, 1, 2, 3].map((p) => ({ priority: p, open: open.filter((t) => t.priority === p).length })),
        targets,
      };
    }

    const names = new Map<number, string>();
    for (const id of new Set([...updates.map((u) => u.user_id), ...(project.lead_id ? [project.lead_id] : [])])) names.set(id, await userName(db, id));

    res.json({
      project: { ...project, lead_name: project.lead_id ? (names.get(project.lead_id) ?? null) : null },
      access: { can_write: pa.canWrite, can_manage: canEditProject(pa, me), can_sign_off: await canSignOff(pa, me) },
      transitions: TRANSITIONS[pa.stage as Stage],
      progress: { ...stats, tasks_blocked: blocked!.n },
      by_status: byStatus,
      pipeline,
      support,
      intake: project.type === "support" && canEditProject(pa, me) ? { enabled: !!intakeToken, token: (intakeToken as string | null) ?? null } : null,
      workload: assignees.map((a) => ({ assignee_id: a.assignee_id, open: a.n })),
      time: { tracked_min: Math.round((time!.tracked ?? 0) / 60), estimate_min: time!.estimate ?? 0 },
      milestones,
      updates: updates.map((u) => ({ ...u, author: names.get(u.user_id) ?? "Someone" })),
    });
  });
}

/** A project's lead must be someone who can work on it. */
export async function assertLeadAllowed(q: Queryable, workspaceId: number | null, ownerId: number, leadId: number): Promise<void> {
  if (workspaceId === null) {
    if (leadId !== ownerId) throw new HttpError(400, "A private project can only be led by its owner");
    return;
  }
  const m = await q.get("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role != 'viewer'", workspaceId, leadId);
  if (!m) throw new HttpError(400, "The lead must be a member of the workspace");
}
