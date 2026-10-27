import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { visibleArgs, visibleTasksSql } from "./access.js";
import type { DB, Queryable } from "./db.js";
import { displayName } from "./dialect.js";
import { HttpError, parseId } from "./http-error.js";
import { canEdit, canView, salesScope, type SalesScope } from "./sales-access.js";

export interface SalesDeps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

export const workspaceIdSchema = z.coerce.number().int().positive();
export const nowIso = () => new Date().toISOString();
export const limitOf = (raw: unknown) => Math.min(Math.max(Number(raw) || 200, 1), 500);

/** "https://www.Acme.com/about" and "sales@acme.com" both give "acme.com"; anything that isn't a hostname gives "". */
export function domainOf(value: string): string {
  const host = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^[^@/]*@/, "").replace(/^www\./, "").split(/[/?#:\s]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : "";
}

/** Mailboxes anyone can have say nothing about a company, so they never identify one. */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "aol.com", "proton.me", "protonmail.com", "msn.com"]);
export const companyDomainOfEmail = (email: string): string => {
  const d = domainOf(email.split("@")[1] ?? "");
  return PUBLIC_MAIL.has(d) ? "" : d;
};

export const owner = (D: DB["dialect"], alias = "o") => displayName(D, alias);

export type RecordKind = "lead" | "deal" | "account" | "contact";
export const RECORD_TABLE: Record<RecordKind, string> = { lead: "leads", deal: "deals", account: "accounts", contact: "contacts" };
const WHAT: Record<RecordKind, string> = { lead: "Lead", deal: "Deal", account: "Account", contact: "Contact" };

/** A record the caller may see (404 otherwise), with their scope in the record's workspace. */
export async function loadRecord<T extends { id: number; workspace_id: number; owner_id: number | null }>(
  db: Queryable, kind: RecordKind, rawId: unknown, userId: number,
): Promise<{ row: T; scope: SalesScope; canEdit: boolean }> {
  const row = await db.get<T>(`SELECT * FROM ${RECORD_TABLE[kind]} WHERE id = ?`, parseId(rawId, `${WHAT[kind]} not found`));
  const scope = row ? await salesScope(db, row.workspace_id, userId) : null;
  if (!row || !scope || !scope.enabled || !canView(scope, row.owner_id)) throw new HttpError(404, `${WHAT[kind]} not found`);
  return { row, scope, canEdit: canEdit(scope, row.owner_id) };
}

export const mustEdit = (r: { canEdit: boolean }): void => {
  if (!r.canEdit) throw new HttpError(403, "You don't have permission to change that");
};

/** Writes a line of history on a record, in the voice of the app. */
export async function systemNote(q: Queryable, workspaceId: number, userId: number | null, target: Partial<Record<`${RecordKind}_id`, number>>, body: string): Promise<void> {
  await q.run(
    `INSERT INTO sales_activities (workspace_id, user_id, kind, body, occurred_at, lead_id, deal_id, account_id, contact_id)
     VALUES (?, ?, 'system', ?, ?, ?, ?, ?, ?)`,
    workspaceId, userId, body, nowIso(), target.lead_id ?? null, target.deal_id ?? null, target.account_id ?? null, target.contact_id ?? null,
  );
}

/** Marks a lead or deal as touched just now, which is what "stalled" is measured from. */
export async function touch(q: Queryable, kind: "lead" | "deal", id: number): Promise<void> {
  await q.run(`UPDATE ${RECORD_TABLE[kind]} SET last_activity_at = ? WHERE id = ?`, nowIso(), id);
}

export interface ActivityOut {
  id: number;
  kind: string;
  subject: string;
  body: string;
  duration_min: number | null;
  occurred_at: string;
  user_id: number | null;
  user_name: string | null;
  lead_id: number | null;
  deal_id: number | null;
  account_id: number | null;
  contact_id: number | null;
  deal_title: string | null;
}

/** Activities on any of the given records, newest first. */
export async function activitiesOn(q: Queryable, where: Partial<Record<`${RecordKind}_id`, number[]>>, limit = 100): Promise<ActivityOut[]> {
  const parts: string[] = [];
  const args: number[] = [];
  for (const [col, ids] of Object.entries(where)) {
    if (!ids?.length) continue;
    parts.push(`a.${col} IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids.slice(0, 300));
  }
  if (!parts.length) return [];
  return q.all<ActivityOut>(
    `SELECT a.id, a.kind, a.subject, a.body, a.duration_min, a.occurred_at, a.user_id, ${displayName(q.dialect, "u")} AS user_name,
            a.lead_id, a.deal_id, a.account_id, a.contact_id, d.title AS deal_title
     FROM sales_activities a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN deals d ON d.id = a.deal_id
     WHERE ${parts.join(" OR ")} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${limit}`,
    ...args,
  );
}

export interface FollowUp {
  id: number;
  title: string;
  due_at: string | null;
  status: string;
}

/** Tasks about a record that the caller can see. A follow-up is private to whoever made it unless it lives in a project. */
export async function followUpsOn(q: Queryable, userId: number, col: "deal_id" | "lead_id" | "account_id", id: number): Promise<FollowUp[]> {
  return q.all<FollowUp>(
    `SELECT t.id, t.title, t.due_at, t.status FROM tasks t WHERE t.${col} = ? AND t.parent_id IS NULL AND ${visibleTasksSql("t")}
     ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.due_at IS NULL, t.due_at, t.id LIMIT 50`,
    id, ...visibleArgs(userId),
  );
}

/** Of several matches, the one the caller can see if there is one, so the warning can point at it. */
export function visibleFirst<T extends { owner_id: number | null }>(scope: SalesScope, rows: T[]): T | undefined {
  return rows.find((r) => canView(scope, r.owner_id)) ?? rows[0];
}

/** Answers "this already exists" without telling anyone about records they can't see. */
export function duplicate(res: Response, scope: SalesScope, what: string, dup: { id: number; name: string; owner_id: number | null }): void {
  const visible = canView(scope, dup.owner_id);
  res.status(409).json({
    error: `${what} like this already exists${visible ? ` (${dup.name})` : ""}. Add it anyway if it is a different one.`,
    duplicate: visible ? { visible: true, id: dup.id, name: dup.name } : { visible: false },
  });
}

export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-03-31").refine((v) => !Number.isNaN(Date.parse(v)), "Not a real date");
export const optText = (max: number) => z.string().trim().max(max);
