import { fileURLToPath } from "node:url";
import { openDb, type DB, type Queryable } from "./db.js";

/**
 * Copies everything from a SQLite database into an empty PostgreSQL database, keeping every id so that links between
 * rows (and anything a person has bookmarked) stay valid.
 *
 *   node dist/migrate-sqlite-to-postgres.js <sqlite-file> <postgres-url>
 *   (in development: npm run migrate:sqlite-to-postgres -w server -- tasks.db postgres://...)
 */

/** Dependency order: a table appears after every table it references. */
const TABLES = [
  "users", "workspaces", "workspace_members", "workspace_invites", "projects", "statuses", "project_updates", "milestones", "milestone_moves", "milestone_deps", "sales_access", "pipelines", "pipeline_stages", "accounts", "contacts", "leads", "deals", "sales_activities", "lead_forms", "tags", "tasks", "task_tags", "task_deps",
  "checklist_items", "saved_filters", "time_entries", "integrations", "gcal_links", "gmail_seen", "comments",
  "comment_mentions", "activity", "alerts", "meetings", "meeting_tasks",
] as const;

/** Tables whose primary key is a generated `id`; PostgreSQL's counters must be moved past the copied ids. */
const WITH_ID = new Set(["users", "workspaces", "workspace_invites", "projects", "statuses", "project_updates", "milestones", "milestone_moves", "tags", "tasks", "checklist_items", "saved_filters", "time_entries", "comments", "activity", "alerts", "meetings", "sales_access", "pipelines", "pipeline_stages", "accounts", "contacts", "leads", "deals", "sales_activities", "lead_forms"]);

export interface CopyReport {
  copied: Record<string, number>;
}

export async function copySqliteToPostgres(from: DB, to: DB, log: (line: string) => void = () => {}): Promise<CopyReport> {
  if (from.dialect !== "sqlite" || to.dialect !== "postgres") throw new Error("Copies from SQLite to PostgreSQL only");
  const existing = await to.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  if (existing && existing.n > 0) throw new Error("The PostgreSQL database already has accounts in it. Copy into an empty database so nothing is mixed up.");

  const copied: Record<string, number> = {};
  await to.tx(async (t: Queryable) => {
    for (const table of TABLES) {
      const rows = await from.all<Record<string, unknown>>(`SELECT * FROM ${table}${WITH_ID.has(table) ? " ORDER BY id" : ""}`);
      for (const row of rows) {
        // A task may point at a parent created later, so parents are linked in a second pass.
        const values = table === "tasks" ? { ...row, parent_id: null } : row;
        const cols = Object.keys(values);
        await t.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => values[c]));
      }
      if (table === "tasks") {
        for (const row of rows) if (row.parent_id != null) await t.run("UPDATE tasks SET parent_id = ? WHERE id = ?", row.parent_id, row.id);
      }
      copied[table] = rows.length;
      log(`${table.padEnd(18)} ${rows.length}`);
    }
    for (const table of WITH_ID) {
      await t.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT MAX(id) IS NOT NULL FROM ${table}))`);
    }
  });

  // Prove the copy: every table has as many rows on the new side as the old.
  for (const table of TABLES) {
    const n = (await to.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
    if (n !== copied[table]) throw new Error(`${table}: copied ${copied[table]} rows but found ${n} afterwards`);
  }
  return { copied };
}

async function main() {
  const [file, url] = process.argv.slice(2);
  if (!file || !url) {
    console.error("Usage: node dist/migrate-sqlite-to-postgres.js <sqlite-file> <postgres-url>");
    process.exit(2);
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    console.error("The second argument must be a postgres:// URL");
    process.exit(2);
  }
  const from = await openDb(file);
  const to = await openDb(url);
  try {
    console.log(`Copying ${file} -> PostgreSQL`);
    const { copied } = await copySqliteToPostgres(from, to, (l) => console.log("  " + l));
    console.log(`Done. ${Object.values(copied).reduce((a, b) => a + b, 0)} rows copied and verified.`);
  } catch (e) {
    console.error("Migration failed, nothing was changed in PostgreSQL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await from.close();
    await to.close();
  }
}

// Run only when started directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
