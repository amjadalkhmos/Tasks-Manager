/**
 * The database layer. The rest of the server talks to this small async interface and never to a driver directly, so the
 * same code runs on SQLite (the default, a single file) and PostgreSQL.
 *
 * SQL is written once, with `?` placeholders, in the subset both databases understand. The few things that genuinely
 * differ (date arithmetic, a person's display name) live in `dialect.ts`; the schema is in `db-schema.ts`.
 */
export type Dialect = "sqlite" | "postgres";
export type Row = Record<string, any>;

export interface Queryable {
  readonly dialect: Dialect;
  /** All matching rows. */
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** The first matching row, or undefined. */
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  /** Runs a statement and reports how many rows it changed. */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Runs an INSERT into a table with an `id` column and returns the new id. */
  insert(sql: string, ...params: unknown[]): Promise<number>;
  /** Runs one or more statements without parameters (schema changes). */
  exec(sql: string): Promise<void>;
}

export interface DB extends Queryable {
  /**
   * Runs `fn` in a transaction: everything inside commits together, or none of it does if `fn` throws.
   * Inside, use the `t` you are given, never the outer `db` (on PostgreSQL that would run outside the transaction).
   * Do not await anything except database calls inside `fn`.
   */
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Placeholders for an IN (...) list: "?,?,?". */
export const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

const CHUNK = 400;

/** Runs a query once per slice of a long id list (keeps IN lists comfortably below driver limits) and joins the results. */
export async function inChunks<T>(ids: readonly unknown[], fn: (marks: string, ids: unknown[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    out.push(...(await fn(marks(slice.length), slice)));
  }
  return out;
}

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * Opens the database named by `target`: a postgres:// URL for PostgreSQL, otherwise a SQLite file path
 * (":memory:" for a throwaway database). The schema is created or brought up to date on the way.
 */
export async function openDb(target: string): Promise<DB> {
  if (POSTGRES_URL.test(target)) {
    const { openPostgres } = await import("./db-postgres.js");
    return openPostgres(target);
  }
  const { openSqlite } = await import("./db-sqlite.js");
  return openSqlite(target);
}
