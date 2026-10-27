/** An amount in a currency, e.g. "$12,500" (no cents unless there are some). Falls back to "12,500 XYZ" for unknown codes. */
export function formatMoney(amount: number, currency = "USD"): string {
  const fraction = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: fraction, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

/** Minutes as "45m", "3h 20m" or "2d 4h". */
export function formatDuration(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
  const d = Math.floor(min / 1440);
  const h = Math.round((min % 1440) / 60);
  return `${d}d${h ? ` ${h}h` : ""}`;
}
