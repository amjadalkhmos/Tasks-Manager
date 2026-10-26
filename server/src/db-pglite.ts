import { PGlite } from "@electric-sql/pglite";
import { createSchema } from "./db-schema.js";
import { pgQueryable, type PgRunner } from "./db-postgres.js";
import type { DB, Queryable } from "./db.js";

/**
 * PostgreSQL running inside this process (compiled to WebAssembly). It speaks the same SQL as a real server, so the
 * test suite uses it to run every test against PostgreSQL without installing anything.
 * Pass a directory to keep the data on disk, or nothing for a throwaway in-memory database.
 */
export async function openPglite(dataDir?: string): Promise<DB & { reset(): Promise<void> }> {
  const lite = new PGlite(dataDir, { parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) } });
  await lite.waitReady;

  const runner = (r: Pick<PGlite, "query">): PgRunner => ({ query: (text, values) => r.query(text, values) as never });
  const root = pgQueryable(runner(lite), async (sql) => void (await lite.exec(sql)));

  const db: DB & { reset(): Promise<void> } = {
    ...root,
    tx: <T>(fn: (t: Queryable) => Promise<T>) =>
      lite.transaction(async (tx) => fn(pgQueryable(runner(tx), async (sql) => void (await tx.exec(sql))))),
    async close() {
      await lite.close();
    },
    /** Empties every table and restarts the id counters, so one instance can serve many tests. */
    async reset() {
      const tables = await root.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
      if (tables.length) await root.exec(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    },
  };
  await createSchema(db);
  return db;
}
