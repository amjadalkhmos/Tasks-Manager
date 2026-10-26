import pg from "pg";
import { createSchema } from "./db-schema.js";
import type { DB, Queryable, Row } from "./db.js";

// node-postgres returns 64-bit integers (COUNT, SUM of integers) and NUMERIC as strings. Our values are small, and
// SQLite hands back plain numbers, so make both databases look the same to the rest of the server.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/**
 * Turns `?` placeholders into PostgreSQL's `$1, $2, ...`, leaving anything inside a quoted string alone.
 * (The server's SQL never uses a literal `?` for any other purpose.)
 */
export function toPostgresPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null; // a doubled '' re-opens on the next character, which is correct
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "?") {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

const clean = (params: unknown[]): unknown[] => params.map((p) => (p === undefined ? null : p));

/** What both a pool, a checked-out client and PGlite offer. */
export interface PgRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null; affectedRows?: number }>;
}

export function pgQueryable(runner: PgRunner, exec: (sql: string) => Promise<void>): Queryable {
  const q = (sql: string, params: unknown[]) => runner.query(toPostgresPlaceholders(sql), clean(params));
  return {
    dialect: "postgres",
    async all<T = Row>(sql: string, ...params: unknown[]) {
      return (await q(sql, params)).rows as T[];
    },
    async get<T = Row>(sql: string, ...params: unknown[]) {
      return (await q(sql, params)).rows[0] as T | undefined;
    },
    async run(sql: string, ...params: unknown[]) {
      const r = await q(sql, params);
      return { changes: r.rowCount ?? r.affectedRows ?? 0 };
    },
    async insert(sql: string, ...params: unknown[]) {
      return (await q(`${sql} RETURNING id`, params)).rows[0].id as number;
    },
    exec,
  };
}

/**
 * Connects to PostgreSQL (a postgres:// URL; add ?sslmode=require for a hosted database that needs TLS) and makes sure
 * the schema exists.
 */
export async function openPostgres(url: string): Promise<DB> {
  // Hosted databases usually need TLS: add ?sslmode=require to the URL. If the host's certificate can't be verified,
  // PG_SSL=no-verify still encrypts the connection but skips the certificate check (a last resort).
  const ssl = process.env.PG_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // An idle client can be dropped by the server; that must not crash the process.
  pool.on("error", (e) => console.error("Postgres connection error:", e.message));

  const root = pgQueryable(pool, async (sql) => void (await pool.query(sql)));
  const db: DB = {
    ...root,
    async tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        try {
          const result = await fn(pgQueryable(client, async (sql) => void (await client.query(sql))));
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  // Several instances may start together; an advisory lock makes them take turns creating the schema.
  await db.tx(async (t) => {
    await t.get("SELECT pg_advisory_xact_lock(727274)");
    await createSchema(t);
  });
  return db;
}
