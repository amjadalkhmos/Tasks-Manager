const UNITS: [number, string][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
];

/** "just now", "5 minutes ago", "3 days ago"; older than a few weeks falls back to the date. */
export function timeAgo(iso: string, now = Date.now()): string {
  let secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (secs < 45) return "just now";
  for (const [size, unit] of UNITS) {
    if (secs < size) return `${secs} ${unit}${secs === 1 ? "" : "s"} ago`;
    secs = Math.round(secs / size);
  }
  return secs < 5 ? `${secs} week${secs === 1 ? "" : "s"} ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
