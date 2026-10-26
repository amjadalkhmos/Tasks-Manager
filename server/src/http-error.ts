export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads a numeric id from a URL. Anything that isn't a plain positive integer is "not found" (it can't match a row),
 * and must never reach the database: PostgreSQL rejects non-numbers for integer columns instead of returning nothing.
 */
export function parseId(value: unknown, what = "Not found"): number {
  const s = String(value);
  if (!/^\d{1,15}$/.test(s)) throw new HttpError(404, what);
  return Number(s);
}
