import { openDb, type DB } from "./db.js";

/**
 * A fresh, empty database for one test, on whichever backend the run was started for:
 *   TEST_DB=sqlite    (default) a new in-memory SQLite database each time
 *   TEST_DB=pglite    PostgreSQL running inside the test process (no install needed)
 *   TEST_DB=postgres  a real PostgreSQL server, named by TEST_DATABASE_URL (its tables are emptied between tests)
 */
export const backend = (process.env.TEST_DB ?? "sqlite") as "sqlite" | "pglite" | "postgres";

let shared: DB | null = null;

async function emptyAllTables(db: DB) {
  const tables = await db.all<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()");
  if (tables.length) await db.exec(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export async function testDb(): Promise<DB> {
  if (backend === "sqlite") return openDb(":memory:");
  if (!shared) {
    if (backend === "pglite") {
      const { openPglite } = await import("./db-pglite.js");
      shared = await openPglite();
    } else {
      const url = process.env.TEST_DATABASE_URL;
      if (!url) throw new Error("TEST_DB=postgres needs TEST_DATABASE_URL");
      shared = await openDb(url);
    }
  }
  await emptyAllTables(shared); // one connection serves the whole file, so start each test from nothing
  return shared;
}
