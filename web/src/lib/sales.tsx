import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SalesMeOn, SalesPipeline, SalesStage } from "../api";

export interface SalesCtx {
  workspaceId: number;
  me: SalesMeOn;
  pipelines: SalesPipeline[];
}

const Ctx = createContext<SalesCtx | null>(null);
export const SalesProvider = ({ value, children }: { value: SalesCtx; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useSales(): SalesCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSales is used inside the Sales area");
  return c;
}

/** Whether the signed-in person may change records owned by `ownerId` (null: unassigned records). */
export function canEditOwner(me: SalesMeOn, ownerId: number | null): boolean {
  if (me.manager) return true;
  if (ownerId === null) return me.unassigned === "edit";
  return me.owners.find((o) => o.id === ownerId)?.level === "edit";
}

/** Everyone the signed-in person can name: the owners they can see, plus the ones they can assign to. */
export function knownPeople(me: SalesMeOn): { id: number; name: string }[] {
  const seen = new Map<number, string>();
  for (const o of me.owners) seen.set(o.id, o.name);
  for (const o of me.assignable.owners) seen.set(o.id, o.name);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export const STAGE_KIND_LABEL: Record<SalesStage["kind"], string> = { open: "Open", won: "Won", lost: "Lost" };

/** Marks the sales queries stale after a change. Follow-ups are ordinary tasks, so the task lists refresh too. */
export function useRefreshSales() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ["sales"] }), qc.invalidateQueries({ queryKey: ["tasks"] })]);
}

/** Closes on Escape. */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** "2026-03-31" as a short local date. */
export function formatDay(day: string | null): string {
  if (!day) return "—";
  return new Date(`${day.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
