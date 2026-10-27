import type { Express } from "express";
import { z } from "zod";
import { forecast, type Deal as ForecastDeal, type Stage as ForecastStage } from "./forecast.js";
import { likeCI } from "./dialect.js";
import { HttpError, parseId } from "./http-error.js";
import { canView, checkOwner, needView, requireSales, visibleOwners } from "./sales-access.js";
import {
  activitiesOn, day, followUpsOn, limitOf, loadRecord, mustEdit, nowIso, optText, owner as ownerName, systemNote, touch, workspaceIdSchema,
  type RecordKind, type SalesDeps,
} from "./sales-shared.js";
import type { Queryable } from "./db.js";

/** An open deal nobody has touched for this long is stalled. */
export const STALLED_DAYS = 14;
const DAY_MS = 86_400_000;
const daysSince = (iso: string | null, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS)) : 0);

const dealFields = {
  title: z.string().trim().min(1, "Give the deal a title").max(200),
  account_id: z.number().int().positive().nullable(),
  contact_id: z.number().int().positive().nullable(),
  pipeline_id: z.number().int().positive(),
  stage_id: z.number().int().positive(),
  value: z.number().min(0, "A value can't be negative").max(1e12).nullable(),
  expected_close: day.nullable(),
  notes: optText(5000),
  lost_reason: optText(200),
};
const dealCreate = z.object({ ...dealFields, workspace_id: workspaceIdSchema, owner_id: z.number().int().positive().nullable() }).partial()
  .required({ workspace_id: true, title: true, pipeline_id: true, account_id: true }).extend({ account_id: z.number().int().positive() });
const dealPatch = z.object({ ...dealFields, owner_id: z.number().int().positive().nullable() }).partial();

const activityBody = z.object({
  lead_id: z.number().int().positive().optional(),
  deal_id: z.number().int().positive().optional(),
  account_id: z.number().int().positive().optional(),
  contact_id: z.number().int().positive().optional(),
  kind: z.enum(["call", "email", "meeting", "note"]),
  subject: optText(200).default(""),
  body: optText(5000).default(""),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  duration_min: z.number().int().min(0).max(24 * 60).nullable().optional(),
}).refine((b) => [b.lead_id, b.deal_id, b.account_id, b.contact_id].filter((v) => v !== undefined).length === 1, "Log it against exactly one lead, deal, account or contact")
  .refine((b) => b.subject !== "" || b.body !== "", "Say something about it");

interface StageRow { id: number; pipeline_id: number; name: string; color: string; probability: number; kind: "open" | "won" | "lost" }

export const asForecastStage = (s: StageRow): ForecastStage => ({
  id: s.id, name: s.name, color: s.color, category: s.kind === "open" ? "doing" : "done",
  probability: s.kind === "won" ? 100 : s.kind === "lost" ? 0 : s.probability,
});

export function registerSalesDeals(app: Express, { db, auth, uid }: SalesDeps) {
  const D = db.dialect;
  const like = (q: unknown) => `%${String(q).trim()}%`;

  const pipelineOf = async (q: Queryable, wid: number, id: number) => {
    const p = await q.get<{ id: number; name: string; currency: string }>("SELECT id, name, currency FROM pipelines WHERE id = ? AND workspace_id = ?", id, wid);
    if (!p) throw new HttpError(400, "Pick a pipeline from this workspace");
    return p;
  };
  const stageIn = async (q: Queryable, pipelineId: number, id?: number) => {
    const s = id
      ? await q.get<StageRow>("SELECT * FROM pipeline_stages WHERE id = ? AND pipeline_id = ?", id, pipelineId)
      : await q.get<StageRow>("SELECT * FROM pipeline_stages WHERE pipeline_id = ? AND kind = 'open' ORDER BY position, id LIMIT 1", pipelineId);
    if (!s) throw new HttpError(400, id ? "Pick a stage from that pipeline" : "That pipeline has no open stage to start in");
    return s;
  };

  /** The account and contact a deal is about: they must exist here, be visible to the caller, and belong together. */
  async function linkTargets(scope: Awaited<ReturnType<typeof requireSales>>, accountId: number | null | undefined, contactId: number | null | undefined, currentAccount: number | null) {
    const wid = scope.workspaceId;
    if (accountId) {
      const a = await db.get<{ owner_id: number | null }>("SELECT owner_id FROM accounts WHERE id = ? AND workspace_id = ?", accountId, wid);
      if (!a) throw new HttpError(404, "Account not found");
      needView(scope, a.owner_id, "Account");
    }
    if (contactId) {
      const c = await db.get<{ owner_id: number | null; account_id: number | null }>("SELECT owner_id, account_id FROM contacts WHERE id = ? AND workspace_id = ?", contactId, wid);
      if (!c) throw new HttpError(404, "Contact not found");
      needView(scope, c.owner_id, "Contact");
      const account = accountId === undefined ? currentAccount : accountId;
      if (c.account_id !== null && account !== null && c.account_id !== account) throw new HttpError(400, "That contact belongs to a different account");
    }
  }

  // ---------- deals ----------
  app.get("/api/sales/deals", auth, async (req, res) => {
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, uid(req));
    const vis = visibleOwners(scope, "d.owner_id");
    const where = ["d.workspace_id = ?", vis.sql];
    const args: unknown[] = [wid, ...vis.args];
    if (req.query.pipeline_id) (where.push("d.pipeline_id = ?"), args.push(Number(req.query.pipeline_id) || 0));
    const state = typeof req.query.state === "string" ? req.query.state : "all";
    if (["open", "won", "lost"].includes(state)) (where.push("s.kind = ?"), args.push(state));
    if (req.query.unassigned) where.push("d.owner_id IS NULL");
    else if (req.query.owner_id) (where.push("d.owner_id = ?"), args.push(Number(req.query.owner_id) || 0));
    if (req.query.account_id) (where.push("d.account_id = ?"), args.push(Number(req.query.account_id) || 0));
    if (req.query.q) (where.push(`(${likeCI("d.title")} OR ${likeCI("a.name")})`), args.push(like(req.query.q), like(req.query.q)));
    const rows = await db.all<any>(
      `SELECT d.id, d.title, d.value, d.expected_close, d.closed_at, d.created_at, d.stage_changed_at, d.last_activity_at, d.pipeline_id, d.stage_id, d.owner_id,
              ${ownerName(D)} AS owner_name, d.account_id, a.name AS account_name, d.contact_id, c.name AS contact_name,
              s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind, s.probability, p.currency
       FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = d.pipeline_id
         LEFT JOIN accounts a ON a.id = d.account_id LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN users o ON o.id = d.owner_id
       WHERE ${where.join(" AND ")} ORDER BY d.id DESC LIMIT ${limitOf(req.query.limit)}`,
      ...args,
    );
    const now = Date.now();
    res.json(rows.map((d) => ({ ...d, stalled: d.stage_kind === "open" && daysSince(d.last_activity_at, now) >= STALLED_DAYS, days_in_stage: daysSince(d.stage_changed_at, now) })));
  });

  app.post("/api/sales/deals", auth, async (req, res) => {
    const b = dealCreate.parse(req.body);
    const me = uid(req);
    const scope = await requireSales(db, b.workspace_id, me);
    const ownerId = b.owner_id === undefined ? me : b.owner_id;
    await checkOwner(db, scope, ownerId);
    await linkTargets(scope, b.account_id, b.contact_id, null);
    const pipeline = await pipelineOf(db, b.workspace_id, b.pipeline_id);
    const stage = await stageIn(db, pipeline.id, b.stage_id);
    const id = await db.tx(async (t) => {
      const created = await t.insert(
        `INSERT INTO deals (workspace_id, pipeline_id, stage_id, owner_id, account_id, contact_id, title, value, expected_close, closed_at, lost_reason, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        b.workspace_id, pipeline.id, stage.id, ownerId, b.account_id, b.contact_id ?? null, b.title, b.value ?? null, b.expected_close ?? null,
        stage.kind === "open" ? null : nowIso(), stage.kind === "lost" ? (b.lost_reason ?? "") : "", b.notes ?? "", me,
      );
      await systemNote(t, b.workspace_id, me, { deal_id: created }, `Created in ${stage.name}`);
      return created;
    });
    res.status(201).json({ id });
  });

  app.get("/api/sales/deals/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "deal", req.params.id, me);
    const d = r.row;
    const [extra, stages] = await Promise.all([
      db.get<any>(
        `SELECT ${ownerName(D)} AS owner_name, a.name AS account_name, a.owner_id AS account_owner_id, c.name AS contact_name, p.name AS pipeline_name, p.currency,
                s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind, s.probability
         FROM deals d JOIN pipelines p ON p.id = d.pipeline_id JOIN pipeline_stages s ON s.id = d.stage_id LEFT JOIN accounts a ON a.id = d.account_id
           LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN users o ON o.id = d.owner_id WHERE d.id = ?`, d.id,
      ),
      db.all("SELECT id, name, color, kind, probability FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id", d.pipeline_id),
    ]);
    const { account_owner_id, ...rest } = extra;
    res.json({
      ...d, ...rest, can_edit: r.canEdit,
      // The account's page is only linked when the caller can open it; its name is shown either way.
      account_visible: d.account_id !== null && canView(r.scope, account_owner_id),
      stalled: rest.stage_kind === "open" && daysSince(d.last_activity_at) >= STALLED_DAYS,
      days_in_stage: daysSince(d.stage_changed_at),
      stages, activities: await activitiesOn(db, { deal_id: [d.id] }), followups: await followUpsOn(db, me, "deal_id", d.id),
    });
  });

  app.patch("/api/sales/deals/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "deal", req.params.id, me);
    mustEdit(r);
    const b = dealPatch.parse(req.body);
    const d = r.row;
    if (b.owner_id !== undefined) await checkOwner(db, r.scope, b.owner_id, d.owner_id);
    if (b.account_id !== undefined || b.contact_id !== undefined) await linkTargets(r.scope, b.account_id, b.contact_id, d.account_id);
    if (b.account_id === null) throw new HttpError(400, "A deal needs an account");

    const pipelineId = b.pipeline_id ?? d.pipeline_id;
    if (b.pipeline_id !== undefined && b.pipeline_id !== d.pipeline_id) {
      await pipelineOf(db, d.workspace_id, b.pipeline_id);
      if (b.stage_id === undefined) throw new HttpError(400, "Choose a stage in the new pipeline");
    }
    const stage = b.stage_id !== undefined ? await stageIn(db, pipelineId, b.stage_id) : null;
    const moved = stage !== null && stage.id !== d.stage_id;

    const sets: string[] = [];
    const args: unknown[] = [];
    for (const k of ["title", "account_id", "contact_id", "pipeline_id", "value", "expected_close", "notes", "owner_id"] as const) if (b[k] !== undefined) (sets.push(`${k} = ?`), args.push(b[k]));
    if (b.account_id !== undefined && b.contact_id === undefined && d.contact_id !== null && b.account_id !== d.account_id) {
      const c = await db.get<{ account_id: number | null }>("SELECT account_id FROM contacts WHERE id = ?", d.contact_id);
      if (c?.account_id !== null && c?.account_id !== b.account_id) sets.push("contact_id = NULL"); // the old account's contact no longer applies
    }
    if (stage) {
      sets.push("stage_id = ?");
      args.push(stage.id);
      if (moved) {
        sets.push("stage_changed_at = ?", "last_activity_at = ?", "closed_at = ?");
        args.push(nowIso(), nowIso(), stage.kind === "open" ? null : nowIso());
      }
      if (stage.kind !== "lost") sets.push("lost_reason = ''");
    }
    if (b.lost_reason !== undefined && (stage ? stage.kind === "lost" : true)) (sets.push("lost_reason = ?"), args.push(b.lost_reason));

    await db.tx(async (t) => {
      if (sets.length) await t.run(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`, ...args, d.id);
      if (moved) {
        const from = await t.get<{ name: string }>("SELECT name FROM pipeline_stages WHERE id = ?", d.stage_id);
        await systemNote(t, d.workspace_id, me, { deal_id: d.id }, `Moved from ${from?.name ?? "?"} to ${stage!.name}${stage!.kind === "lost" && b.lost_reason ? ` (${b.lost_reason})` : ""}`);
      }
      if (b.owner_id !== undefined && b.owner_id !== d.owner_id) {
        const to = b.owner_id === null ? "nobody" : ((await t.get<{ n: string }>(`SELECT ${ownerName(D, "u")} AS n FROM users u WHERE u.id = ?`, b.owner_id))?.n ?? "someone");
        await systemNote(t, d.workspace_id, me, { deal_id: d.id }, `Owner changed to ${to}`);
      }
    });
    res.json({ id: d.id });
  });

  app.delete("/api/sales/deals/:id", auth, async (req, res) => {
    const r = await loadRecord<any>(db, "deal", req.params.id, uid(req));
    mustEdit(r);
    await db.run("DELETE FROM deals WHERE id = ?", r.row.id);
    res.status(204).end();
  });

  // ---------- activities ----------
  app.post("/api/sales/activities", auth, async (req, res) => {
    const me = uid(req);
    const b = activityBody.parse(req.body);
    const kind = (["lead", "deal", "account", "contact"] as RecordKind[]).find((k) => b[`${k}_id` as const] !== undefined)!;
    const targetId = b[`${kind}_id` as const]!;
    const r = await loadRecord<any>(db, kind, targetId, me);
    mustEdit(r);
    const id = await db.tx(async (t) => {
      const created = await t.insert(
        `INSERT INTO sales_activities (workspace_id, user_id, kind, subject, body, duration_min, occurred_at, ${kind}_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        r.row.workspace_id, me, b.kind, b.subject, b.body, b.duration_min ?? null, b.occurred_at ?? nowIso(), targetId,
      );
      if (kind === "lead" || kind === "deal") {
        await touch(t, kind, targetId);
        if (kind === "lead" && r.row.status === "new") await t.run("UPDATE leads SET status = 'working' WHERE id = ?", targetId); // first contact: no longer new
      }
      return created;
    });
    res.status(201).json({ id });
  });

  app.delete("/api/sales/activities/:id", auth, async (req, res) => {
    const me = uid(req);
    const a = await db.get<any>("SELECT * FROM sales_activities WHERE id = ?", parseId(req.params.id, "Activity not found"));
    if (!a) throw new HttpError(404, "Activity not found");
    const kind = (["lead", "deal", "account", "contact"] as RecordKind[]).find((k) => a[`${k}_id`] !== null);
    if (!kind) throw new HttpError(404, "Activity not found");
    const r = await loadRecord<any>(db, kind, a[`${kind}_id`], me);
    mustEdit(r);
    if (a.kind === "system") throw new HttpError(403, "History written by the app can't be removed");
    if (a.user_id !== me && !r.scope.manager) throw new HttpError(403, "Only the person who logged it, or an admin, can remove it");
    await db.run("DELETE FROM sales_activities WHERE id = ?", a.id);
    res.status(204).end();
  });

  // ---------- follow-ups (tasks about a sales record) ----------
  const followUpBody = z.object({
    lead_id: z.number().int().positive().optional(),
    deal_id: z.number().int().positive().optional(),
    account_id: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(200),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
  }).refine((b) => [b.lead_id, b.deal_id, b.account_id].filter((v) => v !== undefined).length === 1, "Attach it to exactly one lead, deal or account");

  app.post("/api/sales/followups", auth, async (req, res) => {
    const me = uid(req);
    const b = followUpBody.parse(req.body);
    const kind = (["lead", "deal", "account"] as const).find((k) => b[`${k}_id` as const] !== undefined)!;
    const col = `${kind}_id` as "lead_id" | "deal_id" | "account_id";
    await loadRecord<any>(db, kind, b[col], me); // seeing the record is enough to plan your own follow-up on it
    const id = await db.insert(`INSERT INTO tasks (user_id, title, due_at, status, ${col}) VALUES (?, ?, ?, 'todo', ?)`, me, b.title, b.due_at ?? null, b[col]);
    res.status(201).json({ id });
  });

  /** My own open follow-ups across Sales, soonest first. */
  app.get("/api/sales/my-followups", auth, async (req, res) => {
    const me = uid(req);
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, me);
    const rows = await db.all<any>(
      `SELECT t.id, t.title, t.due_at, t.deal_id, t.lead_id, t.account_id, d.title AS deal_title, d.owner_id AS deal_owner, l.name AS lead_name, l.owner_id AS lead_owner,
              a.name AS account_name, a.owner_id AS account_owner
       FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.status <> 'done' AND t.parent_id IS NULL
         AND COALESCE(d.workspace_id, l.workspace_id, a.workspace_id) = ?
       ORDER BY t.due_at IS NULL, t.due_at, t.id LIMIT 100`,
      me, wid,
    );
    res.json(
      rows
        .filter((t) => (t.deal_id ? canView(scope, t.deal_owner) : t.lead_id ? canView(scope, t.lead_owner) : canView(scope, t.account_owner)))
        .map((t) => ({ id: t.id, title: t.title, due_at: t.due_at, deal_id: t.deal_id, lead_id: t.lead_id, account_id: t.account_id, about: t.deal_title ?? t.lead_name ?? t.account_name })),
    );
  });

  // ---------- forecast ----------
  app.get("/api/sales/forecast", auth, async (req, res) => {
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, uid(req));
    const pipelines = await db.all<{ id: number; name: string; currency: string }>("SELECT id, name, currency FROM pipelines WHERE workspace_id = ? ORDER BY position, id", wid);
    const pipeline = pipelines.find((p) => p.id === Number(req.query.pipeline_id)) ?? pipelines[0];

    // Leads, for the same eyes.
    const lv = visibleOwners(scope, "owner_id");
    const leadRows = await db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM leads WHERE workspace_id = ? AND ${lv.sql} GROUP BY status`, wid, ...lv.args);
    const leadCount = (s: string) => Number(leadRows.find((r) => r.status === s)?.n ?? 0);
    const inbox = scope.manager || scope.unassigned !== null
      ? Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND owner_id IS NULL AND status IN ('new','working')", wid))!.n)
      : null;
    const leads = { new: leadCount("new"), working: leadCount("working"), qualified: leadCount("qualified"), disqualified: leadCount("disqualified"), inbox };
    if (!pipeline) return void res.json({ pipeline: null, pipelines, leads });

    const vis = visibleOwners(scope, "d.owner_id");
    const where = ["d.pipeline_id = ?", vis.sql];
    const args: unknown[] = [pipeline.id, ...vis.args];
    if (req.query.owner_id) (where.push("d.owner_id = ?"), args.push(Number(req.query.owner_id) || 0));
    const [stages, deals] = await Promise.all([
      db.all<StageRow>("SELECT * FROM pipeline_stages WHERE pipeline_id = ? ORDER BY position, id", pipeline.id),
      db.all<any>(
        `SELECT d.id, d.title, d.value, d.expected_close, d.closed_at, d.created_at, d.last_activity_at, d.stage_id, d.owner_id, s.kind
         FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE ${where.join(" AND ")}`,
        ...args,
      ),
    ]);
    const fStages = stages.map(asForecastStage);
    const toForecast = (d: any): ForecastDeal => ({ status: d.kind === "open" ? "doing" : "done", status_id: d.stage_id, value: d.value, due_at: d.expected_close, completed_at: d.closed_at });
    const total = forecast(deals.map(toForecast), fStages);

    // By owner: each person's slice of what the caller can see.
    const ownerIds = [...new Set(deals.map((d) => d.owner_id as number | null))];
    const names = new Map<number, string>();
    for (const o of ownerIds) {
      if (o === null) continue;
      const u = await db.get<{ n: string }>(`SELECT ${ownerName(D, "u")} AS n FROM users u WHERE u.id = ?`, o);
      names.set(o, u?.n ?? "Someone");
    }
    const by_owner = ownerIds.map((o) => {
      const f = forecast(deals.filter((d) => d.owner_id === o).map(toForecast), fStages);
      return { owner_id: o, owner_name: o === null ? "Unassigned" : (names.get(o) ?? "Someone"), open_count: f.open_count, open_value: f.open_value, weighted_value: f.weighted_value, won_count: f.won_count, won_value: f.won_value, lost_count: f.lost_count };
    }).sort((a, b) => b.weighted_value - a.weighted_value);

    const won = deals.filter((d) => d.kind === "won" && d.closed_at);
    const avg_cycle_days = won.length ? Math.round((won.reduce((n, d) => n + (Date.parse(d.closed_at) - Date.parse(d.created_at)) / DAY_MS, 0) / won.length) * 10) / 10 : null;
    const open = deals.filter((d) => d.kind === "open");
    const today = new Date().toISOString().slice(0, 10);
    const stalled = open.filter((d) => daysSince(d.last_activity_at) >= STALLED_DAYS)
      .sort((a, b) => Date.parse(a.last_activity_at) - Date.parse(b.last_activity_at)).slice(0, 10)
      .map((d) => ({ id: d.id, title: d.title, value: d.value, owner_id: d.owner_id, days: daysSince(d.last_activity_at) }));
    const overdue_count = open.filter((d) => d.expected_close && d.expected_close < today).length;

    res.json({
      pipeline, pipelines, forecast: total, by_owner, avg_cycle_days, stalled, overdue_count, stalled_days: STALLED_DAYS,
      leads,
    });
  });
}
