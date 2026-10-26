import type { CSSProperties } from "react";
import type { StatusOption } from "../lib/statuses";

/** A task's status as a small coloured label. */
export function StatusChip({ status }: { status: Pick<StatusOption, "name" | "color"> }) {
  return (
    <span className="status-chip" style={{ "--c": status.color } as CSSProperties} title={`Status: ${status.name}`}>
      <span className="dot" aria-hidden="true" />
      {status.name}
    </span>
  );
}
