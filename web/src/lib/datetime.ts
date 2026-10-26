// <input type="datetime-local"> works in local time without a zone; convert to and from ISO.
export const toLocalInput = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

/** The next whole hour from now: a sensible default start for a new meeting. */
export function nextHour(now = new Date()): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

const timeOf = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayOf = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Tue, Oct 28 · 3:00 PM – 3:30 PM", or both dates when the meeting spans days. */
export function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (s.toDateString() === e.toDateString()) return `${dayOf(s)} · ${timeOf(s)} – ${timeOf(e)}`;
  return `${dayOf(s)} ${timeOf(s)} → ${dayOf(e)} ${timeOf(e)}`;
}

/** Only web links are made clickable. The server enforces this too; this keeps a stray value from ever becoming a live link. */
export function safeUrl(v: string | null | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
