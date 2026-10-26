import type { ReactNode } from "react";

export function EmptyState({ icon, title, children, compact }: { icon: ReactNode; title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={compact ? "empty compact" : "empty"}>
      <div className="glyph" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="skeleton" aria-busy="true" aria-label="Loading tasks">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} />
      ))}
    </ul>
  );
}
