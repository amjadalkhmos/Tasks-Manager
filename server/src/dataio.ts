import express, { type Express, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { csvRecords, parseCsv, toCsv } from "./csv.js";
import { inChunks, type DB, type Queryable } from "./db.js";
import { HttpError } from "./http-error.js";
import { isHttpUrl } from "./meetings.js";
import { parseRule, recurrenceSchema, type Recurrence } from "./recurrence.js";

interface Deps {
  db: DB;
  auth: RequestHandler;
  uid: (req: Request) => number;
}

const MAX_TASKS = 5000;
const iso = z.string().datetime({ offset: true });

// ---------- export ----------

interface ExportedTask {
  id: number;
  parent_id: number | null;
  project_id: number | null;
  title: string;
  notes: string;
  priority: number;
  status: string;
  due_at: string | null;
  remind_at: string | null;
  recurrence: Recurrence | null;
  estimate_min: number | null;
  position: number;
  completed_at: string | null;
  tags: string[];
  checklist: { text: string; done: boolean }[];
  blocked_by: number[];
}

export async function buildExport(db: Queryable, userId: number) {
  // Private data only: shared workspaces belong to everyone in them, so they are not part of one person's export.
  const projects = await db.all("SELECT id, name, color FROM projects WHERE user_id = ? AND workspace_id IS NULL ORDER BY id", userId);
  const rows = await db.all<Record<string, any> & { id: number; recurrence_rule: string | null }>(
    `SELECT * FROM tasks WHERE user_id = ? AND (project_id IS NULL OR project_id IN (SELECT id FROM projects WHERE workspace_id IS NULL)) ORDER BY id`,
    userId,
  );
  const ids = rows.map((r) => r.id);
  const [tagRows, checkRows, depRows] = await Promise.all([
    inChunks(ids, (m, a) => db.all<{ task_id: number; name: string }>(`SELECT tt.task_id, g.name FROM tags g JOIN task_tags tt ON tt.tag_id = g.id WHERE tt.task_id IN (${m}) ORDER BY g.name`, ...a)),
    inChunks(ids, (m, a) => db.all<{ task_id: number; text: string; done: number }>(`SELECT task_id, text, done FROM checklist_items WHERE task_id IN (${m}) ORDER BY position, id`, ...a)),
    inChunks(ids, (m, a) => db.all<{ task_id: number; blocked_by_id: number }>(`SELECT task_id, blocked_by_id FROM task_deps WHERE task_id IN (${m})`, ...a)),
  ]);
  const of = <T extends { task_id: number }>(list: T[], id: number) => list.filter((x) => x.task_id === id);

  const tasks: ExportedTask[] = rows.map((r) => ({
    id: r.id,
    parent_id: r.parent_id as number | null,
    project_id: r.project_id as number | null,
    title: r.title as string,
    notes: r.notes as string,
    priority: r.priority as number,
    status: r.status as string,
    due_at: r.due_at as string | null,
    remind_at: r.remind_at as string | null,
    recurrence: parseRule(r.recurrence_rule),
    estimate_min: r.estimate_min as number | null,
    position: r.position as number,
    completed_at: r.completed_at as string | null,
    tags: of(tagRows, r.id).map((t) => t.name),
    checklist: of(checkRows, r.id).map((c) => ({ text: c.text, done: !!c.done })),
    blocked_by: of(depRows, r.id).map((d) => d.blocked_by_id),
  }));

  const filters = (await db.all<{ name: string; query_json: string }>("SELECT name, query_json FROM saved_filters WHERE user_id = ? ORDER BY id", userId)).map((f) => ({
    name: f.name,
    query: JSON.parse(f.query_json) as Record<string, string | number>,
  }));

  // Private meetings made in the app, with the tasks they are linked to. (Shared meetings belong to the workspace, and
  // meetings that come from a calendar are fetched again by the calendar sync, so neither is part of a personal export.)
  const meetingRows = await db.all<Record<string, any>>("SELECT * FROM meetings WHERE user_id = ? AND workspace_id IS NULL AND source = 'local' ORDER BY id", userId);
  const meetingLinks = await inChunks(meetingRows.map((m) => m.id), (m, a) => db.all<{ meeting_id: number; task_id: number }>(`SELECT meeting_id, task_id FROM meeting_tasks WHERE meeting_id IN (${m}) ORDER BY task_id`, ...a));
  const meetings = meetingRows.map((m) => ({
    id: m.id as number, title: m.title as string, notes: m.notes as string, starts_at: m.starts_at as string, ends_at: m.ends_at as string,
    location: m.location as string, url: m.url as string, task_ids: meetingLinks.filter((l) => l.meeting_id === m.id).map((l) => l.task_id),
  }));

  return { version: 1, exported_at: new Date().toISOString(), projects, tasks, filters, meetings };
}

export async function exportCsv(db: Queryable, userId: number): Promise<string> {
  const data = await buildExport(db, userId);
  const projectName = new Map((data.projects as { id: number; name: string }[]).map((p) => [p.id, p.name]));
  return toCsv([
    ["id", "parent_id", "title", "notes", "project", "priority", "status", "due_at", "remind_at", "recurrence", "tags", "estimate_min", "completed_at"],
    ...data.tasks.map((t) => [
      t.id, t.parent_id, t.title, t.notes, t.project_id ? projectName.get(t.project_id) : "", t.priority, t.status,
      t.due_at, t.remind_at, t.recurrence ? JSON.stringify(t.recurrence) : "", t.tags.join(";"), t.estimate_min, t.completed_at,
    ]),
  ]);
}

// ---------- import ----------

/** A task in a neutral shape that every importer produces; `ref` links children and dependencies. */
interface Incoming {
  ref: string;
  parentRef?: string | null;
  project?: string | null;
  title: string;
  notes?: string;
  priority?: number;
  status?: "todo" | "doing" | "done";
  due_at?: string | null;
  remind_at?: string | null;
  recurrence?: Recurrence | null;
  estimate_min?: number | null;
  position?: number | null;
  completed_at?: string | null;
  tags?: string[];
  checklist?: { text: string; done: boolean }[];
  blockedByRefs?: string[];
}

interface IncomingMeeting {
  title: string;
  notes?: string;
  starts_at: string;
  ends_at: string;
  location?: string;
  url?: string;
  /** `ref`s of the imported tasks this meeting is linked to. */
  taskRefs: string[];
}

interface ImportResult {
  tasks: number;
  projects: number;
  filters: number;
  meetings: number;
  warnings: string[];
}

const clean = (s: string) => s.replace(/^'(?=[=+\-@\t\r])/, "").trim();

/** Zone-less "YYYY-MM-DD[ HH:MM]" is read in the client's zone (`tz` = minutes east of UTC); anything with a zone is kept. */
export function parseDate(raw: string, tz: number): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) - tz * 60_000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

async function insertAll(
  db: DB,
  userId: number,
  items: Incoming[],
  filters: { name: string; query: Record<string, string | number> }[],
  defaultProject?: string,
  meetings: IncomingMeeting[] = [],
): Promise<ImportResult> {
  if (items.length > MAX_TASKS) throw new HttpError(413, `Too many tasks (max ${MAX_TASKS} per import)`);
  const warnings: string[] = [];
  const projectIds = new Map<string, number>();
  let projectsCreated = 0;

  await db.tx(async (t) => {
    const projectId = async (name: string | null | undefined) => {
      const n = (name ?? defaultProject ?? "").trim();
      if (!n) return null;
      const key = n.toLowerCase();
      if (projectIds.has(key)) return projectIds.get(key)!;
      const existing = await t.get<{ id: number }>("SELECT id FROM projects WHERE user_id = ? AND workspace_id IS NULL AND lower(name) = ?", userId, key);
      let id = existing?.id;
      if (!id) {
        id = await t.insert("INSERT INTO projects (user_id, name) VALUES (?, ?)", userId, n.slice(0, 100));
        projectsCreated++;
      }
      projectIds.set(key, id);
      return id;
    };

    const idByRef = new Map<string, number>();
    for (const it of items) {
      const status = it.status ?? "todo";
      const id = await t.insert(
        `INSERT INTO tasks (user_id, project_id, title, notes, priority, status, due_at, remind_at, recurrence_rule, estimate_min, completed_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS REAL), (SELECT COALESCE(MAX(position), 0) + 1 FROM tasks WHERE user_id = ?)))`,
        userId, await projectId(it.project), it.title.slice(0, 500), (it.notes ?? "").slice(0, 10000),
        Math.min(3, Math.max(0, it.priority ?? 0)), status, it.due_at ?? null, it.remind_at ?? null,
        it.recurrence ? JSON.stringify(it.recurrence) : null, it.estimate_min ?? null,
        status === "done" ? (it.completed_at ?? new Date().toISOString()) : null, it.position ?? null, userId,
      );
      idByRef.set(it.ref, id);
      for (const name of new Set((it.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))) {
        await t.run("INSERT INTO tags (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING", userId, name.slice(0, 50));
        const tag = (await t.get<{ id: number }>("SELECT id FROM tags WHERE user_id = ? AND name = ?", userId, name.slice(0, 50)))!;
        await t.run("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, tag.id);
      }
      let position = 0;
      for (const c of it.checklist ?? [])
        await t.run("INSERT INTO checklist_items (task_id, text, done, position) VALUES (?, ?, ?, ?)", id, c.text.slice(0, 500), Number(c.done), ++position);
    }
    // Second pass: relations need every task to exist first.
    for (const it of items) {
      const id = idByRef.get(it.ref)!;
      if (it.parentRef) {
        const parent = idByRef.get(it.parentRef);
        if (parent && parent !== id) await t.run("UPDATE tasks SET parent_id = ? WHERE id = ?", parent, id);
        else warnings.push(`"${it.title}": parent not found, imported as a top-level task`);
      }
    }
    for (const it of items) {
      const id = idByRef.get(it.ref)!;
      for (const ref of it.blockedByRefs ?? []) {
        const dep = idByRef.get(ref);
        if (!dep || dep === id) continue;
        const cycle = await t.get(
          `WITH RECURSIVE chain(id) AS (SELECT CAST(? AS INTEGER) UNION SELECT d.blocked_by_id FROM task_deps d JOIN chain c ON d.task_id = c.id) SELECT 1 FROM chain WHERE id = ?`,
          dep,
          id,
        );
        if (cycle) warnings.push(`"${it.title}": skipped a dependency that would create a cycle`);
        else await t.run("INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, dep);
      }
    }
    for (const f of filters) await t.run("INSERT INTO saved_filters (user_id, name, query_json) VALUES (?, ?, ?)", userId, f.name.slice(0, 100), JSON.stringify(f.query));
    for (const m of meetings) {
      const meetingId = await t.insert(
        "INSERT INTO meetings (user_id, title, notes, starts_at, ends_at, location, url) VALUES (?, ?, ?, ?, ?, ?, ?)",
        userId, m.title.slice(0, 200), (m.notes ?? "").slice(0, 10000), m.starts_at, m.ends_at, (m.location ?? "").slice(0, 200), isHttpUrl(m.url ?? "") ? m.url! : "",
      );
      for (const ref of new Set(m.taskRefs)) {
        const taskId = idByRef.get(ref);
        if (taskId) await t.run("INSERT INTO meeting_tasks (meeting_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING", meetingId, taskId);
      }
    }
  });

  return { tasks: items.length, projects: projectsCreated, filters: filters.length, meetings: meetings.length, warnings };
}

const ownSchema = z.object({
  version: z.literal(1),
  projects: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
  tasks: z
    .array(
      z.object({
        id: z.number(),
        parent_id: z.number().nullable().optional(),
        project_id: z.number().nullable().optional(),
        title: z.string().min(1),
        notes: z.string().optional(),
        priority: z.number().int().optional(),
        status: z.enum(["todo", "doing", "done"]).optional(),
        due_at: iso.nullable().optional(),
        remind_at: iso.nullable().optional(),
        recurrence: recurrenceSchema.nullable().optional(),
        estimate_min: z.number().int().nullable().optional(),
        position: z.number().nullable().optional(),
        completed_at: iso.nullable().optional(),
        tags: z.array(z.string()).optional(),
        checklist: z.array(z.object({ text: z.string(), done: z.boolean() })).optional(),
        blocked_by: z.array(z.number()).optional(),
      }),
    )
    .max(MAX_TASKS),
  filters: z.array(z.object({ name: z.string(), query: z.record(z.string(), z.union([z.string(), z.number()])) })).default([]),
  meetings: z
    .array(
      z.object({
        title: z.string().min(1),
        notes: z.string().optional(),
        starts_at: iso,
        ends_at: iso,
        location: z.string().optional(),
        url: z.string().optional(),
        task_ids: z.array(z.number()).default([]),
      }),
    )
    .max(MAX_TASKS)
    .default([]),
});

function fromOwn(body: unknown) {
  const d = ownSchema.parse(body);
  const names = new Map(d.projects.map((p) => [p.id, p.name]));
  const items: Incoming[] = d.tasks.map((t) => ({
    ref: String(t.id),
    parentRef: t.parent_id == null ? null : String(t.parent_id),
    project: t.project_id == null ? null : (names.get(t.project_id) ?? null),
    title: t.title, notes: t.notes, priority: t.priority, status: t.status, due_at: t.due_at, remind_at: t.remind_at,
    recurrence: t.recurrence, estimate_min: t.estimate_min, position: t.position, completed_at: t.completed_at,
    tags: t.tags, checklist: t.checklist, blockedByRefs: (t.blocked_by ?? []).map(String),
  }));
  return { items, filters: d.filters, meetings: d.meetings.map((m) => ({ ...m, taskRefs: m.task_ids.map(String) })) };
}

const PRIORITY_WORDS: Record<string, number> = { none: 0, low: 1, medium: 2, med: 2, high: 3 };

/** Generic CSV: needs a `title` column; optional notes, project, priority, status, due_at, remind_at, tags. */
function fromCsv(text: string, tz: number) {
  const warnings: string[] = [];
  const records = csvRecords(parseCsv(text));
  if (records.length && !("title" in records[0])) throw new HttpError(400, 'CSV needs a "title" column');
  const items: Incoming[] = [];
  records.forEach((r, i) => {
    const title = clean(r.title ?? "");
    if (!title) return;
    const due = parseDate(r.due_at ?? r.due ?? "", tz);
    if ((r.due_at ?? r.due ?? "").trim() && !due) warnings.push(`Row ${i + 2}: unrecognised date "${r.due_at ?? r.due}" ignored`);
    const p = (r.priority ?? "").trim().toLowerCase();
    items.push({
      ref: r.id || String(i), parentRef: r.parent_id || null, title, notes: clean(r.notes ?? ""), project: clean(r.project ?? "") || null,
      priority: PRIORITY_WORDS[p] ?? (Number.isInteger(Number(p)) && p !== "" ? Number(p) : 0),
      status: (["todo", "doing", "done"] as const).find((s) => s === (r.status ?? "").trim().toLowerCase()),
      due_at: due, remind_at: parseDate(r.remind_at ?? "", tz),
      tags: (r.tags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean),
    });
  });
  return { items, warnings };
}

/** Todoist's per-project CSV export: TYPE, CONTENT, DESCRIPTION, PRIORITY (1 = highest), INDENT, DATE, ... */
function fromTodoist(text: string, tz: number) {
  const warnings: string[] = [];
  const items: Incoming[] = [];
  const stack: string[] = []; // ref of the last task at each indent level
  let recurring = 0;
  csvRecords(parseCsv(text)).forEach((r, i) => {
    if ((r.type ?? "task").trim().toLowerCase() !== "task") return;
    const title = clean(r.content ?? "");
    if (!title) return;
    const indent = Math.max(1, Number(r.indent) || 1);
    const ref = `todoist-${i}`;
    stack.length = indent - 1;
    const parentRef = indent > 1 ? (stack[indent - 2] ?? null) : null;
    stack[indent - 1] = ref;
    const p = Number(r.priority);
    const dateRaw = r.date ?? "";
    const due = parseDate(dateRaw, tz);
    if (dateRaw.trim() && !due) /^every|daily|weekly|monthly/i.test(dateRaw) ? recurring++ : warnings.push(`"${title}": date "${dateRaw}" not understood, imported without a date`);
    items.push({ ref, parentRef, title, notes: r.description ?? "", priority: p >= 1 && p <= 3 ? 4 - p : 0, due_at: due });
  });
  if (recurring) warnings.push(`${recurring} recurring task(s) imported without their repeat rule — set it again in the task panel`);
  return { items, warnings };
}

const trelloSchema = z.object({
  name: z.string().optional(),
  lists: z.array(z.object({ id: z.string(), name: z.string(), closed: z.boolean().optional() })).default([]),
  cards: z
    .array(
      z.object({
        id: z.string(), name: z.string(), desc: z.string().optional(), idList: z.string(), closed: z.boolean().optional(),
        due: z.string().nullable().optional(), dueComplete: z.boolean().optional(), pos: z.number().optional(),
        labels: z.array(z.object({ name: z.string().optional() })).optional(),
      }),
    )
    .default([]),
  checklists: z.array(z.object({ idCard: z.string(), checkItems: z.array(z.object({ name: z.string(), state: z.string(), pos: z.number().optional() })) })).default([]),
});

function fromTrello(body: unknown) {
  const b = trelloSchema.parse(body);
  const warnings: string[] = [];
  const lists = new Map(b.lists.map((l) => [l.id, l]));
  const statusOf = (name: string) => (/done|complete|shipped/i.test(name) ? "done" : /doing|progress|review|wip/i.test(name) ? "doing" : "todo");
  let archived = 0;
  const items: Incoming[] = [];
  for (const c of b.cards) {
    const list = lists.get(c.idList);
    if (c.closed || list?.closed) {
      archived++;
      continue;
    }
    const due = c.due ? new Date(c.due) : null;
    items.push({
      ref: c.id, title: c.name, notes: c.desc, project: b.name ?? "Trello import",
      status: c.dueComplete ? "done" : statusOf(list?.name ?? ""),
      due_at: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
      position: c.pos ?? null,
      tags: (c.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
      checklist: b.checklists
        .filter((cl) => cl.idCard === c.id)
        .flatMap((cl) => [...cl.checkItems].sort((a, z) => (a.pos ?? 0) - (z.pos ?? 0)))
        .map((i) => ({ text: i.name, done: i.state === "complete" })),
    });
  }
  if (archived) warnings.push(`${archived} archived card(s) skipped`);
  return { items, warnings };
}

export function registerDataIo(app: Express, { db, auth, uid }: Deps) {
  app.get("/api/export", auth, async (req, res) => {
    res.setHeader("Content-Disposition", 'attachment; filename="tasks-export.json"');
    res.json(await buildExport(db, uid(req)));
  });

  app.get("/api/export.csv", auth, async (req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="tasks-export.csv"');
    res.send(await exportCsv(db, uid(req)));
  });

  const query = z.object({
    format: z.enum(["json", "csv", "todoist", "trello"]),
    project: z.string().max(100).optional(),
    tz: z.coerce.number().int().min(-840).max(840).default(0),
  });

  app.post(
    "/api/import",
    auth,
    express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }),
    async (req, res) => {
      const q = query.parse(req.query);
      const isText = typeof req.body === "string";
      if ((q.format === "csv" || q.format === "todoist") && !isText) throw new HttpError(415, "Send CSV with Content-Type: text/csv");
      if ((q.format === "json" || q.format === "trello") && isText) throw new HttpError(415, "Send JSON with Content-Type: application/json");

      let result: ImportResult;
      if (q.format === "json") {
        const { items, filters, meetings } = fromOwn(req.body);
        result = await insertAll(db, uid(req), items, filters, undefined, meetings);
      } else if (q.format === "trello") {
        const { items, warnings } = fromTrello(req.body);
        result = await insertAll(db, uid(req), items, [], "Trello import");
        result.warnings.push(...warnings);
      } else if (q.format === "todoist") {
        const { items, warnings } = fromTodoist(req.body as string, q.tz);
        result = await insertAll(db, uid(req), items, [], q.project || "Todoist import");
        result.warnings.push(...warnings);
      } else {
        const { items, warnings } = fromCsv(req.body as string, q.tz);
        result = await insertAll(db, uid(req), items, [], q.project);
        result.warnings.push(...warnings);
      }
      res.status(201).json(result);
    },
  );
}
