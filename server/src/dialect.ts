import type { Dialect } from "./db.js";

/**
 * The handful of SQL fragments that differ between SQLite and PostgreSQL. Everything else in the server is plain SQL
 * shared by both. Timestamps are stored as ISO-8601 text in both databases, so these work on text columns.
 */

/**
 * Seconds since 1970 for a timestamp expression, as a floating-point number in both databases (PostgreSQL's EXTRACT
 * yields NUMERIC, which drivers hand back as a string). Values must carry a zone, e.g. end in "Z".
 */
export const epoch = (d: Dialect, expr: string): string =>
  d === "sqlite"
    ? `CAST(strftime('%s', ${expr}) AS REAL)`
    : `CAST(EXTRACT(EPOCH FROM CAST(${expr} AS TIMESTAMPTZ)) AS DOUBLE PRECISION)`;

/**
 * The calendar day ("YYYY-MM-DD") of a timestamp expression for someone whose clock is offset from UTC.
 * Contains ONE `?` placeholder: the offset in minutes east of UTC.
 */
export const localDay = (d: Dialect, expr: string): string =>
  d === "sqlite"
    ? `date(${expr}, (? || ' minutes'))`
    : `to_char(((CAST(${expr} AS TIMESTAMPTZ) AT TIME ZONE 'UTC') + (CAST(? AS INTEGER) * INTERVAL '1 minute')), 'YYYY-MM-DD')`;

/** A person's display name: the name they chose, else the part of their email before the "@". */
export const displayName = (d: Dialect, alias = "u"): string =>
  `COALESCE(NULLIF(TRIM(${alias}.name), ''), substr(${alias}.email, 1, ${d === "sqlite" ? "instr" : "strpos"}(${alias}.email, '@') - 1))`;

/** SUM of a condition (1 for each row where it holds), never NULL. Portable: PostgreSQL can't sum booleans. */
export const countWhere = (cond: string): string => `COALESCE(SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END), 0)`;

/** Case-insensitive substring match (SQLite's LIKE already is; PostgreSQL's isn't). Takes the column and one `?`. */
export const likeCI = (col: string): string => `LOWER(${col}) LIKE LOWER(?)`;
