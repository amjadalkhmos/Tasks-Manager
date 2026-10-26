import Database from "better-sqlite3";
import { createSchema } from "./db-schema.js";
import type { DB, Queryable, Row } from "./db.js";

const STATEMENT_CACHE_LIMIT = 500;

/** SQLite takes numbers, strings, null and buffers only. */
const clean = (params: unknown[]): unknown[] =>
  params.map((p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p));

/** Shared by the root handle and its transactions: `open` is set while a transaction is running. */
interface Gate {
  open: Promise<void> | null;
}

/**
 * better-sqlite3 is synchronous; this wraps it in the async interface. A handle with a gate waits while a transaction
 * is open, so a statement from one request can never slip into another request's transaction on the shared
 * connection. The handle given to a transaction has no gate, so its own statements run straight away.
 */
function queryable(raw: Database.Database, cache: Map<string, Database.Statement>, gate: Gate | null): Queryable {
  const ready = async () => {
    if (gate) while (gate.open) await gate.open;
  };
  const stmt = (sql: string): Database.Statement => {
    let s = cache.get(sql);
    if (!s) {
      if (cache.size >= STATEMENT_CACHE_LIMIT) cache.clear();
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  return {
    dialect: "sqlite",
    async all<T = Row>(sql: string, ...params: unknown[]) {
      await ready();
      return stmt(sql).all(...clean(params)) as T[];
    },
    async get<T = Row>(sql: string, ...params: unknown[]) {
      await ready();
      return stmt(sql).get(...clean(params)) as T | undefined;
    },
    async run(sql: string, ...params: unknown[]) {
      await ready();
      return { changes: stmt(sql).run(...clean(params)).changes };
    },
    async insert(sql: string, ...params: unknown[]) {
      await ready();
      return (stmt(`${sql} RETURNING id`).get(...clean(params)) as { id: number }).id;
    },
    async exec(sql: string) {
      await ready();
      raw.exec(sql);
    },
  };
}

export async function openSqlite(file: string): Promise<DB> {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");

  const cache = new Map<string, Database.Statement>();
  const gate: Gate = { open: null };
  const root = queryable(raw, cache, gate);

  const db: DB = {
    ...root,
    async tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> {
      while (gate.open) await gate.open;
      let release!: () => void;
      gate.open = new Promise<void>((resolve) => (release = resolve));
      try {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(queryable(raw, cache, null));
          raw.exec("COMMIT");
          return result;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      } finally {
        gate.open = null;
        release();
      }
    },
    async close() {
      raw.close();
    },
  };

  await createSchema(db);
  return db;
}
