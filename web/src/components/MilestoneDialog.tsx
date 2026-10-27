import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Circle, Trash2 } from "lucide-react";
import { ApiError, api, type MilestoneDetail, type MilestoneMarker, type MilestoneProgress } from "../api";
import { formatDay } from "../lib/projects";
import { timeAgo } from "../lib/time";
import { Dialog, ErrorLine } from "./sales/bits";
import { MarkerChips, MilestoneBadge } from "./MilestonePanel";

interface Draft {
  name: string;
  description: string;
  criteria: string;
  owner_id: string;
  due_date: string;
  reason: string;
  marker: "" | MilestoneMarker;
  amount: string;
  depends_on: number[];
}
const draftOf = (m: MilestoneDetail): Draft => ({
  name: m.name, description: m.description, criteria: m.criteria, owner_id: m.owner_id ? String(m.owner_id) : "", due_date: m.due_date ?? "", reason: "",
  marker: m.marker ?? "", amount: m.amount === null ? "" : String(m.amount), depends_on: m.depends_on,
});

/** One milestone in full: what it is, who owns it, how its date has moved, what it waits on, and the decision on it. */
export function MilestoneDialog({ id, standing, workspaceId, currency, canSignOff, onClose, onChanged, onOpenTask }: {
  id: number;
  standing: MilestoneProgress | undefined;
  workspaceId: number | null;
  currency: string;
  canSignOff: boolean;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
  onOpenTask: (id: number) => void;
}) {
  const detail = useQuery({ queryKey: ["milestone", id], queryFn: () => api.milestone(id) });
  const ws = useQuery({ queryKey: ["workspace", workspaceId], queryFn: () => api.workspace(workspaceId!), enabled: workspaceId !== null });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const people = workspaceId === null ? (me ? [{ id: me.id, name: me.name }] : []) : (ws.data?.members ?? []).filter((p) => p.role !== "viewer");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState("");
  const [rebase, setRebase] = useState("");
  const [forceNeeded, setForceNeeded] = useState<string | null>(null);

  const refreshAll = async () => {
    await Promise.all([detail.refetch(), onChanged()]);
  };
  const save = useMutation({ mutationFn: (b: Parameters<typeof api.updateMilestone>[1]) => api.updateMilestone(id, b), onSuccess: async () => (setDraft(null), refreshAll()) });
  const decide = useMutation({
    mutationFn: (v: { outcome: "achieved" | "missed"; force?: boolean }) => api.signOffMilestone(id, { outcome: v.outcome, note: note.trim() || undefined, force: v.force }),
    onError: (e) => setForceNeeded(e instanceof ApiError && e.status === 409 && /waits on/.test(e.message) ? e.message : null),
    onSuccess: async () => (setNote(""), setForceNeeded(null), refreshAll()),
  });
  const reopen = useMutation({ mutationFn: () => api.reopenMilestone(id), onSuccess: refreshAll });
  const invoiced = useMutation({ mutationFn: (v: boolean) => api.setMilestoneInvoiced(id, v), onSuccess: refreshAll });
  const remove = useMutation({ mutationFn: () => api.deleteMilestone(id), onSuccess: async () => (await onChanged(), onClose()) });
  const rebaseline = useMutation({ mutationFn: (d: string | null) => api.updateMilestone(id, { baseline_date: d }), onSuccess: async () => (setRebase(""), refreshAll()) });

  const m = detail.data;
  const open = m?.outcome === null;
  const f = m ? (draft ?? draftOf(m)) : null;
  const set = (patch: Partial<Draft>) => m && setDraft({ ...(draft ?? draftOf(m)), ...patch });
  const dirty = !!m && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(m));
  const dateMoved = !!m && !!f && (f.due_date || null) !== m.due_date;

  const submit = () => {
    if (!m || !f) return;
    const b: Parameters<typeof api.updateMilestone>[1] = {};
    if (f.name.trim() !== m.name) b.name = f.name.trim();
    if (f.description !== m.description) b.description = f.description;
    if (f.criteria !== m.criteria) b.criteria = f.criteria;
    if ((f.owner_id ? Number(f.owner_id) : null) !== m.owner_id) b.owner_id = f.owner_id ? Number(f.owner_id) : null;
    if ((f.due_date || null) !== m.due_date) {
      b.due_date = f.due_date || null;
      if (f.reason.trim()) b.reason = f.reason.trim();
    }
    if ((f.marker || null) !== m.marker) b.marker = f.marker || null;
    if (f.marker === "payment" && (f.amount === "" ? null : Number(f.amount)) !== m.amount) b.amount = f.amount === "" ? null : Number(f.amount);
    if (JSON.stringify([...f.depends_on].sort()) !== JSON.stringify([...m.depends_on].sort())) b.depends_on = f.depends_on;
    if (Object.keys(b).length) save.mutate(b);
  };

  const state = m?.outcome ?? standing?.state ?? "upcoming";
  return (
    <Dialog title={m?.name ?? standing?.name ?? "Milestone"} onClose={onClose} wide>
      {detail.isLoading && <p className="muted" role="status">Loading…</p>}
      {detail.error && <p className="alert" role="alert">{detail.error.message}</p>}
      {m && f && (
        <div className="ms-dialog">
          <div className="row-inline">
            <MilestoneBadge state={state} />
            <MarkerChips m={m} currency={currency} />
            <span className="muted small">
              {m.due_date ? `Forecast ${formatDay(m.due_date)}` : "No date yet"}{m.baseline_date && m.baseline_date !== m.due_date ? ` · baseline ${formatDay(m.baseline_date)}` : ""}
              {standing && standing.slipped_days > 0 ? ` · ${standing.slipped_days} days late against it` : ""}
            </span>
          </div>

          {open && standing && standing.risks.length > 0 && (
            <div className="alert warn ms-risks" role="status">
              <div>
                <strong>Why it is at risk</strong>
                <ul>{standing.risks.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            </div>
          )}

          {/* ---- the decision ---- */}
          <section className="panel-section" aria-label="Outcome">
            <h3>Outcome</h3>
            {m.outcome === null ? (
              canSignOff ? (
                <div className="settings-form" style={{ maxWidth: "none" }}>
                  <p className="muted small">Whether a milestone was met is a decision, not a count of finished tasks. Check it against the criteria, then record it.</p>
                  <label>Note<textarea rows={2} maxLength={2000} placeholder="Evidence, who agreed, or why it was missed (optional)" value={note} onChange={(e) => setNote(e.target.value)} /></label>
                  {forceNeeded && (
                    <div className="alert dup" role="alert">
                      <span>{forceNeeded}</span>
                      <button type="button" className="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ outcome: "achieved", force: true })}>Achieve anyway</button>
                    </div>
                  )}
                  <div className="row-inline">
                    <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ outcome: "achieved" })}><Check size={15} /> Mark achieved</button>
                    <button type="button" className="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ outcome: "missed" })}>Mark missed</button>
                  </div>
                  {!forceNeeded && <ErrorLine error={decide.error} />}
                </div>
              ) : (
                <p className="muted small">Only the project's lead or a manager can decide this milestone.</p>
              )
            ) : (
              <div className="settings-form" style={{ maxWidth: "none" }}>
                <p>
                  <strong>{m.outcome === "achieved" ? "Achieved" : "Missed"}</strong>
                  {m.signed_off_at && <span className="muted small"> · {formatDay(m.signed_off_at.slice(0, 10))}</span>}
                </p>
                {m.sign_off_note && <p className="muted">{m.sign_off_note}</p>}
                {m.marker === "payment" && m.outcome === "achieved" && (
                  <p className="row-inline">
                    {m.invoiced_at ? <span>Invoiced {formatDay(m.invoiced_at.slice(0, 10))}</span> : <span><strong>Ready to invoice</strong></span>}
                    {canSignOff && <button type="button" className="secondary" disabled={invoiced.isPending} onClick={() => invoiced.mutate(!m.invoiced_at)}>{m.invoiced_at ? "Not invoiced after all" : "Mark invoiced"}</button>}
                  </p>
                )}
                {canSignOff && <p><button type="button" className="secondary" disabled={reopen.isPending} onClick={() => confirm("Reopen this milestone? The decision is removed.") && reopen.mutate()}>Reopen</button></p>}
              </div>
            )}
            <ErrorLine error={reopen.error ?? invoiced.error} />
          </section>

          {/* ---- details ---- */}
          <section className="panel-section" aria-label="Details">
            <h3>Details</h3>
            <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), dirty && submit())}>
              <label>Name<input disabled={!m.can_write} required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <label>What it is<textarea disabled={!m.can_write} rows={2} maxLength={5000} value={f.description} onChange={(e) => set({ description: e.target.value })} /></label>
              <label>How we'll know it's met<textarea disabled={!m.can_write} rows={3} maxLength={5000} placeholder="Acceptance criteria, e.g. “Passes the smoke test and the client has signed the handover”" value={f.criteria} onChange={(e) => set({ criteria: e.target.value })} /></label>
              <div className="two">
                <label>
                  Owner
                  <select disabled={!m.can_write} value={f.owner_id} onChange={(e) => set({ owner_id: e.target.value })}>
                    <option value="">Nobody yet</option>
                    {m.owner_id && !people.some((p) => p.id === m.owner_id) && <option value={m.owner_id}>{m.owner_name}</option>}
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label>
                  Forecast date
                  <input type="date" disabled={!m.can_write || !open} value={f.due_date} onChange={(e) => set({ due_date: e.target.value })} />
                </label>
              </div>
              {dateMoved && m.due_date && <label>Why is the date moving?<input maxLength={500} placeholder="Kept in the history (optional)" value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></label>}
              <div className="two">
                <label>
                  Marks
                  <select disabled={!m.can_write} value={f.marker} onChange={(e) => set({ marker: e.target.value as "" | MilestoneMarker })}>
                    <option value="">Nothing special</option>
                    <option value="payment">A payment (invoice when achieved)</option>
                    <option value="deliverable">A deliverable</option>
                  </select>
                </label>
                {f.marker === "payment" && <label>Amount ({currency})<input disabled={!m.can_write} type="number" min={0} step="any" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></label>}
              </div>
              {m.others.length > 0 && (
                <fieldset className="choice">
                  <legend>Can't be achieved before</legend>
                  {m.others.map((o) => (
                    <label key={o.id} className="check">
                      <input
                        type="checkbox"
                        disabled={!m.can_write || !open}
                        checked={f.depends_on.includes(o.id)}
                        onChange={(e) => set({ depends_on: e.target.checked ? [...f.depends_on, o.id] : f.depends_on.filter((x) => x !== o.id) })}
                      />
                      {o.name}{o.outcome ? <span className="muted small"> ({o.outcome})</span> : null}
                    </label>
                  ))}
                </fieldset>
              )}
              {m.dependents.length > 0 && <p className="muted small">Waiting on this one: {m.dependents.map((d) => d.name).join(", ")}.</p>}
              <ErrorLine error={save.error} />
              {m.can_write && (
                <div className="dialog-actions">
                  <button type="button" className="ghost danger-text" onClick={() => confirm(`Delete “${m.name}”? Tasks in it stay, without a milestone.`) && remove.mutate()}><Trash2 size={14} /> Delete</button>
                  <button type="submit" disabled={!dirty || save.isPending}>Save changes</button>
                </div>
              )}
              <ErrorLine error={remove.error} />
            </form>
          </section>

          {/* ---- how the date has moved ---- */}
          <section className="panel-section" aria-label="Dates">
            <h3>Dates <span className="count">{m.moves.length}</span></h3>
            <p className="muted small">
              Baseline: {m.baseline_date ? formatDay(m.baseline_date) : "not set"}. The baseline is what was first promised; the forecast above is today's best guess.
            </p>
            {canSignOff && (
              <form className="row-inline" onSubmit={(e) => (e.preventDefault(), rebase && rebaseline.mutate(rebase))}>
                <input type="date" aria-label="New baseline" value={rebase} onChange={(e) => setRebase(e.target.value)} />
                <button type="submit" className="secondary" disabled={!rebase || rebaseline.isPending}>Re-baseline</button>
              </form>
            )}
            <ErrorLine error={rebaseline.error} />
            {m.moves.length === 0 && <p className="muted small">The date hasn't moved.</p>}
            <ul className="plain-list">
              {m.moves.map((mv) => (
                <li key={mv.id}>
                  <span>{mv.from_date ? formatDay(mv.from_date) : "no date"} → {mv.to_date ? formatDay(mv.to_date) : "no date"}</span>
                  {mv.reason && <span>{mv.reason}</span>}
                  <span className="muted small">{mv.user_name ?? "Someone"} · {timeAgo(mv.created_at)}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ---- the work behind it ---- */}
          <section className="panel-section" aria-label="Linked tasks">
            <h3>Tasks <span className="count">{m.tasks.length}</span></h3>
            <p className="muted small">Progress is shown for information. It doesn't decide the outcome.</p>
            {m.tasks.length === 0 && <p className="muted small">No tasks are linked. Pick this milestone in a task's panel.</p>}
            <ul className="plain-list">
              {m.tasks.map((t) => (
                <li key={t.id}>
                  {t.status === "done" ? <Check size={14} className="ok" /> : <Circle size={14} className="muted" />}
                  <button type="button" className="link" onClick={() => (onClose(), onOpenTask(t.id))}>{t.title}</button>
                  {t.due_at && <span className={`muted small${t.status !== "done" && Date.parse(t.due_at) < Date.now() ? " late" : ""}`}>due {formatDay(t.due_at.slice(0, 10))}</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Dialog>
  );
}
