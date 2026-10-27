import { randomBytes } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { parseCsv, csvRecords } from "./csv.js";
import type { Queryable } from "./db.js";
import { likeCI } from "./dialect.js";
import { notify } from "./events.js";
import { HttpError, parseId } from "./http-error.js";
import { rateLimiter } from "./intake.js";
import { checkOwner, needEdit, requireSales, visibleOwners, type SalesScope } from "./sales-access.js";
import {
  activitiesOn, companyDomainOfEmail, day, domainOf, duplicate, followUpsOn, limitOf, loadRecord, mustEdit, nowIso, optText, owner as ownerName,
  systemNote, visibleFirst, workspaceIdSchema, type SalesDeps,
} from "./sales-shared.js";

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const email = z.string().trim().toLowerCase().max(200).refine((v) => v === "" || z.string().email().safeParse(v).success, "That doesn't look like an email address");

const leadFields = {
  name: z.string().trim().min(1, "Give the lead a name").max(200),
  email,
  phone: optText(50),
  company: optText(200),
  job_title: optText(100),
  source: z.enum(["manual", "other"]),
  source_detail: optText(200),
  notes: optText(5000),
  status: z.enum(["new", "working"]),
};
const leadCreate = z.object({
  ...leadFields,
  workspace_id: workspaceIdSchema,
  owner_id: z.number().int().positive().nullable().optional(),
  allow_duplicate: z.boolean().optional(),
}).partial().required({ workspace_id: true, name: true });
const leadPatch = z.object({ ...leadFields, owner_id: z.number().int().positive().nullable() }).partial();

const dealSeed = z.object({
  title: z.string().trim().min(1).max(200),
  pipeline_id: z.number().int().positive(),
  stage_id: z.number().int().positive().optional(),
  value: z.number().min(0).max(1e12).nullable().optional(),
  expected_close: day.nullable().optional(),
  owner_id: z.number().int().positive().nullable().optional(),
});
const qualifyBody = z.object({
  /** An existing account to attach to, or the details of a new one. Omitted: a new account named after the lead's company, if it has one. */
  account: z.union([z.object({ id: z.number().int().positive() }), z.object({ name: z.string().trim().min(1).max(200), website: optText(200).optional(), industry: optText(100).optional() })]).optional(),
  create_contact: z.boolean().default(true),
  deal: dealSeed.nullable().optional(),
  allow_duplicate: z.boolean().optional(),
});

/** Header names people commonly use, mapped to the lead field they mean. */
const GUESS: Record<string, string> = {
  name: "name", "full name": "name", fullname: "name", "contact name": "name", contact: "name",
  email: "email", "e-mail": "email", "email address": "email", mail: "email",
  phone: "phone", telephone: "phone", mobile: "phone", "phone number": "phone", tel: "phone",
  company: "company", organization: "company", organisation: "company", "company name": "company", account: "company",
  title: "job_title", "job title": "job_title", position: "job_title", role: "job_title",
  source: "source_detail", "lead source": "source_detail", notes: "notes", note: "notes", comments: "notes", description: "notes",
};
const IMPORT_FIELDS = ["name", "email", "phone", "company", "job_title", "source_detail", "notes"] as const;
const MAX_IMPORT_ROWS = 5000;

export function registerSalesLeads(app: Express, { db, auth, uid }: SalesDeps) {
  const D = db.dialect;
  const like = (q: unknown) => `%${String(q).trim()}%`;
  const formLimit = rateLimiter(5, 15 * 60_000); // per visitor and form
  const formTotal = rateLimiter(300, 60 * 60_000); // per form, in total
  const probeLimit = rateLimiter(60, 60_000);

  /** Another lead or a contact in the workspace with this address. */
  const emailTaken = async (q: Queryable, wid: number, address: string, scope?: SalesScope) => {
    if (!address) return undefined;
    const rows = [
      ...(await q.all<{ id: number; name: string; owner_id: number | null }>("SELECT id, name, owner_id FROM leads WHERE workspace_id = ? AND email = ? AND status <> 'disqualified' ORDER BY id LIMIT 50", wid, address)),
      ...(await q.all<{ id: number; name: string; owner_id: number | null }>("SELECT id, name, owner_id FROM contacts WHERE workspace_id = ? AND email = ? ORDER BY id LIMIT 50", wid, address)),
    ];
    return scope ? visibleFirst(scope, rows) : rows[0];
  };

  // ---------- leads ----------
  app.get("/api/sales/leads", auth, async (req, res) => {
    const wid = workspaceIdSchema.parse(req.query.workspace_id);
    const scope = await requireSales(db, wid, uid(req));
    const vis = visibleOwners(scope, "l.owner_id");
    const where = ["l.workspace_id = ?", vis.sql];
    const args: unknown[] = [wid, ...vis.args];
    const status = typeof req.query.status === "string" ? req.query.status : "open";
    if (status === "open") where.push("l.status IN ('new','working')");
    else if (status !== "all") (where.push("l.status = ?"), args.push(status));
    if (req.query.unassigned) where.push("l.owner_id IS NULL");
    else if (req.query.owner_id) (where.push("l.owner_id = ?"), args.push(Number(req.query.owner_id) || 0));
    if (typeof req.query.source === "string" && req.query.source) (where.push("l.source = ?"), args.push(req.query.source));
    if (req.query.q) {
      where.push(`(${likeCI("l.name")} OR ${likeCI("l.email")} OR ${likeCI("l.company")})`);
      args.push(like(req.query.q), like(req.query.q), like(req.query.q));
    }
    res.json(
      await db.all(
        `SELECT l.id, l.name, l.email, l.phone, l.company, l.job_title, l.source, l.source_detail, l.status, l.owner_id, ${ownerName(D)} AS owner_name,
                l.created_at, l.last_activity_at, l.disqualified_reason, l.deal_id, l.account_id
         FROM leads l LEFT JOIN users o ON o.id = l.owner_id WHERE ${where.join(" AND ")} ORDER BY l.id DESC LIMIT ${limitOf(req.query.limit)}`,
        ...args,
      ),
    );
  });

  app.post("/api/sales/leads", auth, async (req, res) => {
    const b = leadCreate.parse(req.body);
    const scope = await requireSales(db, b.workspace_id, uid(req));
    const ownerId = b.owner_id === undefined ? uid(req) : b.owner_id;
    await checkOwner(db, scope, ownerId);
    const address = b.email ?? "";
    if (!b.allow_duplicate) {
      const dup = await emailTaken(db, b.workspace_id, address, scope);
      if (dup) return void duplicate(res, scope, "A lead or contact", dup);
    }
    const id = await db.insert(
      `INSERT INTO leads (workspace_id, owner_id, name, email, phone, company, job_title, source, source_detail, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.workspace_id, ownerId, b.name, address, b.phone ?? "", b.company ?? "", b.job_title ?? "", b.source ?? "manual", b.source_detail ?? "", b.status ?? "new", b.notes ?? "", uid(req),
    );
    res.status(201).json({ id });
  });

  app.get("/api/sales/leads/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "lead", req.params.id, me);
    const who = await db.get<{ owner_name: string | null }>(`SELECT ${ownerName(D)} AS owner_name FROM leads l LEFT JOIN users o ON o.id = l.owner_id WHERE l.id = ?`, r.row.id);
    res.json({
      ...r.row, owner_name: who?.owner_name ?? null, can_edit: r.canEdit,
      activities: await activitiesOn(db, { lead_id: [r.row.id] }), followups: await followUpsOn(db, me, "lead_id", r.row.id),
    });
  });

  app.patch("/api/sales/leads/:id", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "lead", req.params.id, me);
    mustEdit(r);
    const b = leadPatch.parse(req.body);
    if ((r.row.status === "qualified" || r.row.status === "disqualified") && Object.keys(b).some((k) => k !== "notes" && k !== "owner_id")) {
      throw new HttpError(409, "This lead is closed. Reopen it to change it.");
    }
    if (b.owner_id !== undefined) await checkOwner(db, r.scope, b.owner_id, r.row.owner_id);
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const k of ["name", "email", "phone", "company", "job_title", "source", "source_detail", "notes", "status"] as const) if (b[k] !== undefined) (sets.push(`${k} = ?`), args.push(b[k]));
    if (b.owner_id !== undefined) (sets.push("owner_id = ?"), args.push(b.owner_id));
    await db.tx(async (t) => {
      if (sets.length) await t.run(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, ...args, r.row.id);
      if (b.owner_id !== undefined && b.owner_id !== r.row.owner_id) {
        const to = b.owner_id === null ? "nobody (back to the inbox)" : ((await t.get<{ n: string }>(`SELECT ${ownerName(D, "u")} AS n FROM users u WHERE u.id = ?`, b.owner_id))?.n ?? "someone");
        await systemNote(t, r.row.workspace_id, me, { lead_id: r.row.id }, `Assigned to ${to}`);
        if (b.owner_id !== null) await notify(t, { userId: b.owner_id, kind: "lead", actorId: me, workspaceId: r.row.workspace_id, title: r.row.name });
      }
    });
    res.json({ id: r.row.id });
  });

  app.delete("/api/sales/leads/:id", auth, async (req, res) => {
    const r = await loadRecord<any>(db, "lead", req.params.id, uid(req));
    mustEdit(r);
    await db.run("DELETE FROM leads WHERE id = ?", r.row.id);
    res.status(204).end();
  });

  app.post("/api/sales/leads/:id/disqualify", auth, async (req, res) => {
    const me = uid(req);
    const { reason } = z.object({ reason: z.string().trim().min(1, "Say why").max(200) }).parse(req.body);
    const r = await loadRecord<any>(db, "lead", req.params.id, me);
    mustEdit(r);
    if (r.row.status === "qualified") throw new HttpError(409, "This lead has already been qualified");
    await db.tx(async (t) => {
      await t.run("UPDATE leads SET status = 'disqualified', disqualified_reason = ? WHERE id = ?", reason, r.row.id);
      await systemNote(t, r.row.workspace_id, me, { lead_id: r.row.id }, `Disqualified: ${reason}`);
    });
    res.json({ id: r.row.id });
  });

  app.post("/api/sales/leads/:id/reopen", auth, async (req, res) => {
    const me = uid(req);
    const r = await loadRecord<any>(db, "lead", req.params.id, me);
    mustEdit(r);
    if (r.row.status !== "disqualified") throw new HttpError(409, "Only a disqualified lead can be reopened");
    await db.tx(async (t) => {
      await t.run("UPDATE leads SET status = 'working', disqualified_reason = '', last_activity_at = ? WHERE id = ?", nowIso(), r.row.id);
      await systemNote(t, r.row.workspace_id, me, { lead_id: r.row.id }, "Reopened");
    });
    res.json({ id: r.row.id });
  });

  /**
   * Qualifying turns a lead into the records a sale is made of: an account (new or existing), a contact, and optionally a
   * deal. The lead keeps links to all of them, and stays on file as qualified.
   */
  app.post("/api/sales/leads/:id/qualify", auth, async (req, res) => {
    const me = uid(req);
    const b = qualifyBody.parse(req.body ?? {});
    const r = await loadRecord<any>(db, "lead", req.params.id, me);
    mustEdit(r);
    const lead = r.row;
    if (lead.status === "qualified") throw new HttpError(409, "This lead has already been qualified");
    if (lead.status === "disqualified") throw new HttpError(409, "Reopen this lead before qualifying it");
    const wid = lead.workspace_id;
    const ownerId: number | null = lead.owner_id ?? me;
    await checkOwner(db, r.scope, ownerId, lead.owner_id);

    // The account: one the caller picked, a new one, or one named after the lead's company.
    let accountId: number | null = null;
    let accountOwner: number | null = ownerId;
    const wantedName = b.account && "name" in b.account ? b.account.name : b.account ? "" : lead.company;
    if (b.account && "id" in b.account) {
      const a = await db.get<{ id: number; owner_id: number | null }>("SELECT id, owner_id FROM accounts WHERE id = ? AND workspace_id = ?", b.account.id, wid);
      if (!a) throw new HttpError(404, "Account not found");
      needEdit(r.scope, a.owner_id, "Account");
      accountId = a.id;
      accountOwner = a.owner_id;
    } else if (wantedName) {
      const website = b.account && "website" in b.account ? (b.account.website ?? "") : "";
      const domain = domainOf(website) || companyDomainOfEmail(lead.email);
      if (!b.allow_duplicate) {
        const dup = visibleFirst(r.scope, await db.all<{ id: number; name: string; owner_id: number | null }>(
          `SELECT id, name, owner_id FROM accounts WHERE workspace_id = ? AND (LOWER(name) = LOWER(?)${domain ? " OR domain = ?" : ""}) ORDER BY id LIMIT 50`, wid, wantedName, ...(domain ? [domain] : []),
        ));
        if (dup) return void duplicate(res, r.scope, "An account", dup);
      }
    }
    let dealOwner: number | null = ownerId;
    if (b.deal) {
      dealOwner = b.deal.owner_id === undefined ? ownerId : b.deal.owner_id;
      await checkOwner(db, r.scope, dealOwner);
    }

    const out = await db.tx(async (t) => {
      if (accountId === null && wantedName) {
        const website = b.account && "website" in b.account ? (b.account.website ?? "") : "";
        accountId = await t.insert(
          `INSERT INTO accounts (workspace_id, owner_id, name, website, domain, industry, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'prospect', ?)`,
          wid, ownerId, wantedName, website, domainOf(website) || companyDomainOfEmail(lead.email), b.account && "industry" in b.account ? (b.account.industry ?? "") : "", me,
        );
        accountOwner = ownerId;
      }
      let contactId: number | null = null;
      if (b.create_contact) {
        contactId = await t.insert(
          `INSERT INTO contacts (workspace_id, account_id, owner_id, name, email, phone, job_title, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          wid, accountId, accountId === null ? ownerId : accountOwner, lead.name, lead.email, lead.phone, lead.job_title, lead.notes, me,
        );
      }
      let dealId: number | null = null;
      if (b.deal) {
        const stage = b.deal.stage_id
          ? await t.get<{ id: number; kind: string }>("SELECT s.id, s.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ? AND p.id = ? AND p.workspace_id = ?", b.deal.stage_id, b.deal.pipeline_id, wid)
          : await t.get<{ id: number; kind: string }>("SELECT s.id, s.kind FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE p.id = ? AND p.workspace_id = ? AND s.kind = 'open' ORDER BY s.position, s.id LIMIT 1", b.deal.pipeline_id, wid);
        if (!stage) throw new HttpError(400, "Pick a stage from that pipeline");
        dealId = await t.insert(
          `INSERT INTO deals (workspace_id, pipeline_id, stage_id, owner_id, account_id, contact_id, title, value, expected_close, closed_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          wid, b.deal.pipeline_id, stage.id, dealOwner, accountId, contactId, b.deal.title, b.deal.value ?? null, b.deal.expected_close ?? null, stage.kind === "open" ? null : nowIso(), me,
        );
        await systemNote(t, wid, me, { deal_id: dealId }, `Created from lead ${lead.name}`);
      }
      await t.run("UPDATE leads SET status = 'qualified', qualified_at = ?, account_id = ?, contact_id = ?, deal_id = ?, last_activity_at = ? WHERE id = ?", nowIso(), accountId, contactId, dealId, nowIso(), lead.id);
      await systemNote(t, wid, me, { lead_id: lead.id }, "Qualified");
      return { account_id: accountId, contact_id: contactId, deal_id: dealId };
    });
    res.json({ id: lead.id, ...out });
  });

  // ---------- CSV import ----------
  app.post("/api/sales/leads/import", auth, async (req, res) => {
    const b = z.object({
      workspace_id: workspaceIdSchema,
      csv: z.string().min(1).max(4_000_000),
      /** lead field -> CSV column header. Without it, nothing is imported: the response suggests one. */
      mapping: z.record(z.string(), z.string()).optional(),
      owner_id: z.number().int().positive().nullable().optional(),
      on_duplicate: z.enum(["skip", "create"]).default("skip"),
      source_detail: optText(200).optional(),
    }).parse(req.body);
    const me = uid(req);
    const scope = await requireSales(db, b.workspace_id, me);
    const rows = parseCsv(b.csv);
    const headers = (rows[0] ?? []).map((h) => h.trim());
    if (rows.length < 2) throw new HttpError(400, "That file has no rows below the header");
    if (rows.length - 1 > MAX_IMPORT_ROWS) throw new HttpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`);
    const records = csvRecords(rows);

    const suggested: Record<string, string> = {};
    for (const h of headers) {
      const field = GUESS[h.toLowerCase()];
      if (field && !suggested[field]) suggested[field] = h;
    }
    if (!b.mapping) return void res.json({ headers, suggested, rows: records.length, sample: records.slice(0, 3) });

    for (const [field, header] of Object.entries(b.mapping)) {
      if (!(IMPORT_FIELDS as readonly string[]).includes(field)) throw new HttpError(400, `Unknown field "${field}"`);
      if (header && !headers.some((h) => h.toLowerCase() === header.toLowerCase())) throw new HttpError(400, `The file has no column "${header}"`);
    }
    if (!b.mapping.name) throw new HttpError(400, "Choose which column holds the lead's name");
    // Imported leads go to the inbox by default for managers, to the importer otherwise; either way the caller must be allowed to.
    const ownerId = b.owner_id === undefined ? (scope.manager ? null : me) : b.owner_id;
    await checkOwner(db, scope, ownerId);

    const cell = (rec: Record<string, string>, field: string) => {
      const header = b.mapping![field];
      return header ? (rec[header.toLowerCase()] ?? "").trim() : "";
    };
    const errors: { row: number; message: string }[] = [];
    let created = 0;
    let skipped = 0;
    const seen = new Set<string>();
    const detail = b.source_detail ?? "CSV import";
    await db.tx(async (t) => {
      for (const [i, rec] of records.entries()) {
        const line = i + 2;
        const name = cell(rec, "name").slice(0, 200);
        const address = cell(rec, "email").toLowerCase().slice(0, 200);
        if (!name) { errors.push({ row: line, message: "No name" }); continue; }
        if (address && !z.string().email().safeParse(address).success) { errors.push({ row: line, message: `"${address}" isn't an email address` }); continue; }
        if (address && b.on_duplicate === "skip" && (seen.has(address) || (await emailTaken(t, b.workspace_id, address)))) { skipped += 1; continue; }
        if (address) seen.add(address);
        await t.run(
          `INSERT INTO leads (workspace_id, owner_id, name, email, phone, company, job_title, source, source_detail, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`,
          b.workspace_id, ownerId, name, address, cell(rec, "phone").slice(0, 50), cell(rec, "company").slice(0, 200), cell(rec, "job_title").slice(0, 100),
          (cell(rec, "source_detail") || detail).slice(0, 200), cell(rec, "notes").slice(0, 5000), me,
        );
        created += 1;
      }
    });
    res.json({ created, skipped, failed: errors.length, errors: errors.slice(0, 50) });
  });

  // ---------- public form: management ----------
  const formsManager = async (rawWs: unknown, userId: number): Promise<number> => {
    const wid = workspaceIdSchema.parse(rawWs);
    const scope = await requireSales(db, wid, userId);
    if (!scope.manager) throw new HttpError(403, "Only workspace admins can manage lead forms");
    return wid;
  };

  app.get("/api/sales/forms", auth, async (req, res) => {
    const wid = await formsManager(req.query.workspace_id, uid(req));
    res.json((await db.all("SELECT id, name, token, enabled, created_at FROM lead_forms WHERE workspace_id = ? ORDER BY id", wid)).map((f) => ({ ...f, enabled: !!f.enabled })));
  });

  app.post("/api/sales/forms", auth, async (req, res) => {
    const b = z.object({ workspace_id: workspaceIdSchema, name: z.string().trim().min(1).max(100) }).parse(req.body);
    await formsManager(b.workspace_id, uid(req));
    const token = randomBytes(18).toString("base64url");
    const id = await db.insert("INSERT INTO lead_forms (workspace_id, name, token, created_by) VALUES (?, ?, ?, ?)", b.workspace_id, b.name, token, uid(req));
    res.status(201).json({ id, name: b.name, token, enabled: true });
  });

  app.patch("/api/sales/forms/:id", auth, async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), enabled: z.boolean().optional(), rotate: z.boolean().optional() }).parse(req.body);
    const form = await db.get<{ id: number; workspace_id: number; token: string }>("SELECT id, workspace_id, token FROM lead_forms WHERE id = ?", parseId(req.params.id, "Form not found"));
    if (!form) throw new HttpError(404, "Form not found");
    await formsManager(form.workspace_id, uid(req));
    const token = b.rotate ? randomBytes(18).toString("base64url") : form.token;
    await db.run("UPDATE lead_forms SET name = COALESCE(?, name), enabled = COALESCE(?, enabled), token = ? WHERE id = ?", b.name ?? null, b.enabled === undefined ? null : b.enabled ? 1 : 0, token, form.id);
    res.json({ id: form.id, token });
  });

  app.delete("/api/sales/forms/:id", auth, async (req, res) => {
    const form = await db.get<{ id: number; workspace_id: number }>("SELECT id, workspace_id FROM lead_forms WHERE id = ?", parseId(req.params.id, "Form not found"));
    if (!form) throw new HttpError(404, "Form not found");
    await formsManager(form.workspace_id, uid(req));
    await db.run("DELETE FROM lead_forms WHERE id = ?", form.id);
    res.status(204).end();
  });

  // ---------- public form: the visitor's side ----------
  const findForm = async (token: string) => {
    const f = TOKEN.test(token) ? await db.get<{ id: number; workspace_id: number; name: string; enabled: number }>("SELECT id, workspace_id, name, enabled FROM lead_forms WHERE token = ?", token) : undefined;
    if (!f || !f.enabled) throw new HttpError(404, "This form isn't available");
    return f;
  };

  const inquiry = z.object({
    name: z.string().trim().min(1, "Please tell us your name").max(100),
    email: z.string().trim().toLowerCase().email("Please enter a valid email address").max(200),
    phone: optText(50).optional(),
    company: optText(200).optional(),
    message: optText(5000).optional(),
    /** A field real visitors never see; bots fill it in. */
    website: z.string().max(200).optional(),
  });

  app.get("/api/public/leads/:token", async (req, res) => {
    if (!probeLimit(String(req.ip))) throw new HttpError(429, "Too many requests");
    const f = await findForm(String(req.params.token));
    const ws = await db.get<{ name: string }>("SELECT name FROM workspaces WHERE id = ?", f.workspace_id);
    res.json({ name: f.name, workspace: ws?.name ?? "" });
  });

  app.post("/api/public/leads/:token", async (req, res) => {
    const token = String(req.params.token);
    if (!probeLimit(String(req.ip))) throw new HttpError(429, "Too many requests");
    const f = await findForm(token);
    if (!formLimit(`${req.ip}|${token}`) || !formTotal(token)) throw new HttpError(429, "Too many requests. Please try again later.");
    const b = inquiry.parse(req.body);
    if (b.website) return void res.status(201).json({ ok: true }); // a bot: answer as if it worked, and keep nothing
    await db.tx(async (t) => {
      // Someone writing again isn't a new lead: it goes on the open one as a note.
      const open = await t.get<{ id: number; owner_id: number | null; name: string }>("SELECT id, owner_id, name FROM leads WHERE workspace_id = ? AND email = ? AND status IN ('new','working') ORDER BY id DESC LIMIT 1", f.workspace_id, b.email);
      if (open) {
        await t.run(
          "INSERT INTO sales_activities (workspace_id, user_id, kind, subject, body, occurred_at, lead_id) VALUES (?, NULL, 'note', ?, ?, ?, ?)",
          f.workspace_id, `Wrote again through ${f.name}`, (b.message ?? "").slice(0, 5000), nowIso(), open.id,
        );
        await t.run("UPDATE leads SET last_activity_at = ? WHERE id = ?", nowIso(), open.id);
        if (open.owner_id !== null) await notify(t, { userId: open.owner_id, kind: "lead", actorId: null, workspaceId: f.workspace_id, title: `${open.name} wrote again` });
        return;
      }
      await t.run(
        `INSERT INTO leads (workspace_id, owner_id, name, email, phone, company, source, source_detail, notes) VALUES (?, NULL, ?, ?, ?, ?, 'form', ?, ?)`,
        f.workspace_id, b.name, b.email, b.phone ?? "", b.company ?? "", f.name, b.message ?? "",
      );
      // The inbox's keepers hear about it: workspace admins, and whoever was given the unassigned records to edit.
      const keepers = await t.all<{ user_id: number }>(
        `SELECT m.user_id FROM workspace_members m WHERE m.workspace_id = ? AND (m.role IN ('owner','admin')
           OR (m.role <> 'viewer' AND EXISTS (SELECT 1 FROM sales_access a WHERE a.workspace_id = m.workspace_id AND a.user_id = m.user_id AND a.owner_id IS NULL AND a.level = 'edit')))`,
        f.workspace_id,
      );
      for (const k of keepers) await notify(t, { userId: k.user_id, kind: "lead", actorId: null, workspaceId: f.workspace_id, title: `New lead: ${b.name}` });
    });
    res.status(201).json({ ok: true });
  });
}
