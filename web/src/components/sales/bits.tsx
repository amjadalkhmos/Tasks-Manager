import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { DuplicateError, type SalesMeOn } from "../../api";
import { useEscape } from "../../lib/sales";

/** A modal with a title and a close button. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="backdrop top" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label={title} style={wide ? { width: "min(760px, 94vw)" } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Who a record belongs to, limited to the people the caller may hand records to. */
export function OwnerSelect({ me, value, onChange, currentName, label = "Owner", disabled }: {
  me: SalesMeOn;
  value: number | null;
  onChange: (v: number | null) => void;
  /** Shown for a current owner who isn't among the people the caller may assign to. */
  currentName?: string | null;
  label?: string;
  disabled?: boolean;
}) {
  const people = me.assignable.owners;
  const listed = value === null || people.some((p) => p.id === value);
  return (
    <label>
      {label}
      <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        {(me.assignable.unassigned || value === null) && <option value="" disabled={!me.assignable.unassigned}>Unassigned</option>}
        {!listed && <option value={value!} disabled>{currentName ?? "Someone else"}</option>}
        {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.user_id ? `${p.name} (you)` : p.name}</option>)}
      </select>
    </label>
  );
}

/** "This looks like a record you already have", with a way to carry on anyway. */
export function DuplicateNotice({ dup, onForce, busy }: { dup: DuplicateError; onForce: () => void; busy?: boolean }) {
  return (
    <div className="alert dup" role="alert">
      <span>{dup.message}</span>
      <button type="button" className="secondary" disabled={busy} onClick={onForce}>Add anyway</button>
    </div>
  );
}

/** Shows an error that isn't a duplicate warning (those have their own notice). */
export function ErrorLine({ error }: { error: Error | null }) {
  if (!error || error instanceof DuplicateError) return null;
  return <p className="alert" role="alert">{error.message}</p>;
}

export function Chip({ color, children }: { color?: string; children: ReactNode }) {
  return (
    <span className="s-chip" style={color ? ({ ["--c" as string]: color } as CSSProperties) : undefined}>
      {color && <span className="dot" style={{ background: color }} />}
      {children}
    </span>
  );
}
