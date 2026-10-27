import type { Express } from "express";
import { z } from "zod";
import { likeCI } from "./dialect.js";
import { HttpError } from "./http-error.js";
import { checkOwner, needEdit, requireSales, visibleOwners } from "./sales-access.js";
import {
  activitiesOn, domainOf, duplicate, followUpsOn, limitOf, loadRecord, mustEdit, optText, owner as ownerName, systemNote, visibleFirst, workspaceIdSchema,
  type SalesDeps,
} from "./sales-shared.js";

const accountFields = {
  name: z.string().trim().min(1, "Give the account a name").max(200),
  website: optText(200),
  industry: optText(100),
  size: optText(50),
  phone: optText(50),
  status: z.enum(["prospect", "customer", "churned"]),
  notes: optText(5000),
};
const accountCreate = z.object({
  ...accountFields,
  workspace_id: workspaceIdSchema,
  owner_id: z.number().int().positive().nullable().optional(),
  allow_duplicate: z.boolean().optional(),
}).partial().required({ workspace_id: true, name: true });
const accountPatch = z.object({ ...accountFields, owner_id: z.number().int().positive().nullable() }).partial();

const contactFields = {
  name: z.string().trim().min(1, "Give the contact a name").max(200),
  email: z.string().trim().toLowerCase().max(200).refine((v) => v === "" || z.string().email().safeParse(v).success, "That doesn't look like an email address"),
  phone: optText(50),
  job_title: optText(100),
  notes: optText(5000),
  account_id: z.number().int().positive().nullable(),
};
const contactCreate = z.object({
  ...contactFields,
  workspace_id: workspaceIdSchema,
  owner_id: z.number().int().positive().nullable().optional(),
  allow_duplicate: z.boolean().optional(),
}).partial().required({ workspace_id: true, name: true });
const contactPatch = z.object({ ...contactFields, owner_id: z.number().int().positive().nullable() }).partial();

export function registerSalesAccounts(app: Express, { db, auth, uid }: SalesDeps) {
  const D = db.dialect;
  const like = (q: unknown) => `%${String(q).trim()}%`;

  // ---------- accounts ----------
  app.get("/api/sales/accounts", auth, async (req, res) => {
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, uid(req));
    const vis = visibleOwners(scope, "a.owner_id");
    const dealVis = visibleOwners(scope, "d.owner_id");
    const where = [`a.workspace_id = ?`, vis.sql];
    const args: unknown[] = [wid, ...vis.args];
    if (req.query.q) (where.push(`(${likeCI("a.name")} OR ${likeCI("a.domain")})`), args.push(like(req.query.q), like(req.query.q)));
    if (typeof req.query.status === "string" && req.query.status) (where.push("a.status = ?"), args.push(req.query.status));
    if (req.query.owner_id) (where.push("a.owner_id = ?"), args.push(Number(req.query.owner_id) || 0));
    res.json(
      await db.all(
        `SELECT a.id, a.name, a.website, a.industry, a.size, a.status, a.owner_id, ${ownerName(D)} AS owner_name, a.created_at,
                (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count,
                (SELECT COUNT(*) FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.account_id = a.id AND s.kind = 'open' AND ${dealVis.sql}) AS open_deals,
                (SELECT COALESCE(SUM(d.value), 0) FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.account_id = a.id AND s.kind = 'open' AND ${dealVis.sql}) AS open_value
         FROM accounts a LEFT JOIN users o ON o.id = a.owner_id
         WHERE ${where.join(" AND ")} ORDER BY LOWER(a.name), a.id LIMIT ${limitOf(req.query.limit)}`,
        ...dealVis.args, ...dealVis.args, ...args,
      ),
    );
  });

  app.post("/api/sales/accounts", auth, async (req, res) => {
    const b = accountCreate.parse(req.body);
    const scope = await requireSales(db, b.workspace_id, uid(req));
    const ownerId = b.owner_id === undefined ? uid(req) : b.owner_id;
    await checkOwner(db, scope, ownerId);
    const domain = domainOf(b.website ?? "");
    if (!b.allow_duplicate) {
      const dup = visibleFirst(scope, await db.all<{ id: number; name: string; owner_id: number | null }>(
        `SELECT id, name, owner_id FROM accounts WHERE workspace_id = ? AND (LOWER(name) = LOWER(?)${domain ? " OR domain = ?" : ""}) ORDER BY id LIMIT 50`,
        b.workspace_id, b.name, ...(domain ? [domain] : []),
      ));
      if (dup) return void duplicate(res, scope, "An account", dup);
    }
    const id = await db.insert(
      `INSERT INTO accounts (workspace_id, owner_id, name, website, domain, industry, size, phone, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.workspace_id, ownerId, b.name, b.website ?? "", domain, b.industry ?? "", b.size ?? "", b.phone ?? "", b.status ?? "prospect", b.notes ?? "", uid(req),
    );
    res.status(201).json({ id });
  });

  app.get("/api/sales/accounts/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "account", req.params.id, me);
    const a = r.row;
    const dealVis = visibleOwners(r.scope, "d.owner_id");
    const conVis = visibleOwners(r.scope, "c.owner_id");
    const [who, contacts, deals] = await Promise.all([
      db.get<{ owner_name: string | null }>(`SELECT ${ownerName(D)} AS owner_name FROM accounts a LEFT JOIN users o ON o.id = a.owner_id WHERE a.id = ?`, a.id),
      db.all(`SELECT c.id, c.name, c.email, c.phone, c.job_title FROM contacts c WHERE c.account_id = ? AND ${conVis.sql} ORDER BY LOWER(c.name), c.id`, a.id, ...conVis.args),
      db.all<{ id: number }>(
        `SELECT d.id, d.title, d.value, d.expected_close, d.closed_at, d.owner_id, ${ownerName(D)} AS owner_name, s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind, p.currency
         FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = d.pipeline_id LEFT JOIN users o ON o.id = d.owner_id
         WHERE d.account_id = ? AND ${dealVis.sql} ORDER BY CASE WHEN s.kind = 'open' THEN 0 ELSE 1 END, d.expected_close IS NULL, d.expected_close, d.id`,
        a.id, ...dealVis.args,
      ),
    ]);
    const activities = await activitiesOn(db, { account_id: [a.id], contact_id: (contacts as any[]).map((c) => c.id), deal_id: deals.map((d) => d.id) });
    res.json({ ...a, owner_name: who?.owner_name ?? null, can_edit: r.canEdit, contacts, deals, activities, followups: await followUpsOn(db, me, "account_id", a.id) });
  });

  app.patch("/api/sales/accounts/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "account", req.params.id, me);
    mustEdit(r);
    const b = accountPatch.parse(req.body);
    if (b.owner_id !== undefined) await checkOwner(db, r.scope, b.owner_id, r.row.owner_id);
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const k of ["name", "website", "industry", "size", "phone", "status", "notes"] as const) if (b[k] !== undefined) (sets.push(`${k} = ?`), args.push(b[k]));
    if (b.website !== undefined) (sets.push("domain = ?"), args.push(domainOf(b.website)));
    if (b.owner_id !== undefined) (sets.push("owner_id = ?"), args.push(b.owner_id));
    await db.tx(async (t) => {
      if (sets.length) await t.run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...args, r.row.id);
      if (b.owner_id !== undefined && b.owner_id !== r.row.owner_id) {
        await t.run("UPDATE contacts SET owner_id = ? WHERE account_id = ?", b.owner_id, r.row.id); // contacts follow their account
        const to = b.owner_id === null ? "nobody" : ((await t.get<{ n: string }>(`SELECT ${ownerName(D, "u")} AS n FROM users u WHERE u.id = ?`, b.owner_id))?.n ?? "someone");
        await systemNote(t, r.row.workspace_id, me, { account_id: r.row.id }, `Owner changed to ${to}`);
      }
    });
    res.json({ id: r.row.id });
  });

  app.delete("/api/sales/accounts/:id", auth, async (req, res) => {
    const r = await loadRecord<any>(db, "account", req.params.id, uid(req));
    mustEdit(r);
    const deals = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deals WHERE account_id = ?", r.row.id))!.n;
    if (Number(deals) > 0) throw new HttpError(409, `This account has ${deals} deal${Number(deals) === 1 ? "" : "s"}. Delete or move them first.`);
    await db.run("DELETE FROM accounts WHERE id = ?", r.row.id);
    res.status(204).end();
  });

  // ---------- contacts ----------
  app.get("/api/sales/contacts", auth, async (req, res) => {
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, uid(req));
    const vis = visibleOwners(scope, "c.owner_id");
    const where = [`c.workspace_id = ?`, vis.sql];
    const args: unknown[] = [wid, ...vis.args];
    if (req.query.q) (where.push(`(${likeCI("c.name")} OR ${likeCI("c.email")})`), args.push(like(req.query.q), like(req.query.q)));
    if (req.query.account_id) (where.push("c.account_id = ?"), args.push(Number(req.query.account_id) || 0));
    if (req.query.owner_id) (where.push("c.owner_id = ?"), args.push(Number(req.query.owner_id) || 0));
    res.json(
      await db.all(
        `SELECT c.id, c.name, c.email, c.phone, c.job_title, c.account_id, a.name AS account_name, c.owner_id, ${ownerName(D)} AS owner_name
         FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN users o ON o.id = c.owner_id
         WHERE ${where.join(" AND ")} ORDER BY LOWER(c.name), c.id LIMIT ${limitOf(req.query.limit)}`,
        ...args,
      ),
    );
  });

  /** The owner a contact gets: its account's, or (with no account) whoever the creator chose. */
  async function contactOwner(scope: Awaited<ReturnType<typeof requireSales>>, accountId: number | null | undefined, wanted: number | null | undefined, fallback: number | null) {
    if (accountId) {
      const a = await db.get<{ owner_id: number | null }>("SELECT owner_id FROM accounts WHERE id = ? AND workspace_id = ?", accountId, scope.workspaceId);
      if (!a) throw new HttpError(404, "Account not found");
      needEdit(scope, a.owner_id, "Account");
      return a.owner_id;
    }
    const o = wanted === undefined ? fallback : wanted;
    await checkOwner(db, scope, o);
    return o;
  }

  app.post("/api/sales/contacts", auth, async (req, res) => {
    const b = contactCreate.parse(req.body);
    const scope = await requireSales(db, b.workspace_id, uid(req));
    const ownerId = await contactOwner(scope, b.account_id, b.owner_id, uid(req));
    if (b.email && !b.allow_duplicate) {
      const dup = visibleFirst(scope, await db.all<{ id: number; name: string; owner_id: number | null }>("SELECT id, name, owner_id FROM contacts WHERE workspace_id = ? AND email = ? ORDER BY id LIMIT 50", b.workspace_id, b.email));
      if (dup) return void duplicate(res, scope, "A contact", dup);
    }
    const id = await db.insert(
      `INSERT INTO contacts (workspace_id, account_id, owner_id, name, email, phone, job_title, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.workspace_id, b.account_id ?? null, ownerId, b.name, b.email ?? "", b.phone ?? "", b.job_title ?? "", b.notes ?? "", uid(req),
    );
    res.status(201).json({ id });
  });

  app.get("/api/sales/contacts/:id", auth, async (req, res) => {
    const r = await loadRecord<any>(db, "contact", req.params.id, uid(req));
    const c = r.row;
    const dealVis = visibleOwners(r.scope, "d.owner_id");
    const [extra, deals] = await Promise.all([
      db.get<{ owner_name: string | null; account_name: string | null }>(
        `SELECT ${ownerName(D)} AS owner_name, a.name AS account_name FROM contacts c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = ?`, c.id,
      ),
      db.all(
        `SELECT d.id, d.title, d.value, s.name AS stage_name, s.color AS stage_color, s.kind AS stage_kind, p.currency
         FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id JOIN pipelines p ON p.id = d.pipeline_id WHERE d.contact_id = ? AND ${dealVis.sql} ORDER BY d.id DESC`,
        c.id, ...dealVis.args,
      ),
    ]);
    res.json({ ...c, owner_name: extra?.owner_name ?? null, account_name: extra?.account_name ?? null, can_edit: r.canEdit, deals, activities: await activitiesOn(db, { contact_id: [c.id] }) });
  });

  app.patch("/api/sales/contacts/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "contact", req.params.id, me);
    mustEdit(r);
    const b = contactPatch.parse(req.body);
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const k of ["name", "email", "phone", "job_title", "notes"] as const) if (b[k] !== undefined) (sets.push(`${k} = ?`), args.push(b[k]));
    const newAccount = b.account_id === undefined ? r.row.account_id : b.account_id;
    if (b.account_id !== undefined) {
      sets.push("account_id = ?");
      args.push(b.account_id);
      if (b.account_id !== null) {
        const o = await contactOwner(r.scope, b.account_id, undefined, null);
        sets.push("owner_id = ?");
        args.push(o);
      }
    }
    if (b.owner_id !== undefined && b.owner_id !== r.row.owner_id) {
      if (newAccount !== null) throw new HttpError(400, "A contact belongs to its account's owner. Change the account's owner instead.");
      await checkOwner(db, r.scope, b.owner_id, r.row.owner_id);
      sets.push("owner_id = ?");
      args.push(b.owner_id);
    }
    if (sets.length) await db.run(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`, ...args, r.row.id);
    res.json({ id: r.row.id });
  });

  app.delete("/api/sales/contacts/:id", auth, async (req, res) => {
    const r = await loadRecord<any>(db, "contact", req.params.id, uid(req));
    mustEdit(r);
    await db.run("DELETE FROM contacts WHERE id = ?", r.row.id);
    res.status(204).end();
  });
}
