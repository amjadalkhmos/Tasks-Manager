import type { ClockText } from "../lib/sla";

export function SlaBadge({ clock }: { clock: ClockText }) {
  return <span className={`sla sla-${clock.state}`}>{clock.text}</span>;
}
