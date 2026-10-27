import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Trash2, TriangleAlert } from "lucide-react";
import { salesApi, type DealDetail } from "../../api";
import { ActivityPanel, FollowUpsPanel } from "../../components/sales/ActivityPanel";
import { ErrorLine, OwnerSelect } from "../../components/sales/bits";
import { LostDialog } from "../../components/sales/DealDialogs";
import { formatMoney } from "../../lib/money";
import { formatDay, useRefreshSales, useSales } from "../../lib/sales";

interface Draft {
  title: string;
  value: string;
  expected_close: string;
  notes: string;
  owner_id: number | null;
  contact_id: string;
}
const draftOf = (d: DealDetail): Draft => ({ title: d.title, value: d.value === null ? "" : String(d.value), expected_close: d.expected_close ?? "", notes: d.notes, owner_id: d.owner_id, contact_id: d.contact_id ? String(d.contact_id) : "" });

export function DealPage() {
  const id = Number(useParams().id);
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const deal = useQuery({ queryKey: ["sales", "deal", id], queryFn: () => salesApi.deal(id) });
  const contacts = useQuery({
    queryKey: ["sales", "contacts", wid, { account: deal.data?.account_id }],
    queryFn: () => salesApi.contacts(wid, { account_id: deal.data!.account_id! }),
    enabled: !!deal.data?.account_id && deal.data.account_visible,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [losing, setLosing] = useState<DealDetail["stages"][number] | null>(null);

  const save = useMutation({ mutationFn: (b: Record<string, unknown>) => salesApi.updateDeal(id, b), onSuccess: async () => { setDraft(null); setLosing(null); await refresh(); } });
  const remove = useMutation({ mutationFn: () => salesApi.deleteDeal(id), onSuccess: async () => { await refresh(); navigate(`/sales/${wid}/pipeline`); } });

  if (deal.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (deal.error || !deal.data) return <p className="alert" role="alert">{deal.error?.message ?? "Deal not found"}</p>;
  const d = deal.data;
  const f = draft ?? draftOf(d);
  const set = (patch: Partial<Draft>) => setDraft({ ...f, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(d));
  const edit = d.can_edit;
  const cur = (n: number) => formatMoney(n, d.currency);

  const submit = () => {
    const body: Record<string, unknown> = {};
    if (f.title.trim() !== d.title) body.title = f.title.trim();
    const v = f.value === "" ? null : Number(f.value);
    if (v !== d.value) body.value = v;
    if ((f.expected_close || null) !== d.expected_close) body.expected_close = f.expected_close || null;
    if (f.notes !== d.notes) body.notes = f.notes;
    if (f.owner_id !== d.owner_id) body.owner_id = f.owner_id;
    if ((f.contact_id ? Number(f.contact_id) : null) !== d.contact_id) body.contact_id = f.contact_id ? Number(f.contact_id) : null;
    if (Object.keys(body).length) save.mutate(body);
  };

  return (
    <div className="record-page">
      <p><Link className="back" to={`/sales/${wid}/pipeline`}><ArrowLeft size={14} /> Pipeline</Link></p>
      <header className="record-head">
        <div>
          <h2>{d.title}</h2>
          <p className="muted">
            {d.account_name ? (d.account_visible ? <Link to={`/sales/${wid}/accounts/${d.account_id}`}>{d.account_name}</Link> : d.account_name) : "No account"}
            {d.contact_name ? ` · ${d.contact_name}` : ""} · {d.pipeline_name}
          </p>
        </div>
        <div className="record-value">
          <strong>{d.value === null ? "No value" : cur(d.value)}</strong>
          {d.stage_kind === "open" && d.value !== null && <span className="muted small">{d.probability}% · {cur((d.value * d.probability) / 100)} weighted</span>}
        </div>
      </header>

      <ol className="stage-steps" aria-label="Stage">
        {d.stages.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={s.id === d.stage_id ? "on" : ""}
              style={{ ["--c" as string]: s.color }}
              disabled={!edit || save.isPending || s.id === d.stage_id}
              aria-current={s.id === d.stage_id ? "step" : undefined}
              onClick={() => (s.kind === "lost" ? setLosing(s) : save.mutate({ stage_id: s.id }))}
            >
              {s.name}
            </button>
          </li>
        ))}
      </ol>
      {d.stage_kind === "lost" && d.lost_reason && <p className="muted">Lost: {d.lost_reason}</p>}
      {d.stalled && <p className="alert warn"><TriangleAlert size={15} /> Nobody has logged anything on this deal for a while. Log a call or add a follow-up.</p>}
      {!edit && <p className="muted small">You can see this deal but not change it.</p>}

      <div className="pm-grid">
        <section className="panel" aria-label="Details">
          <h2>Details</h2>
          <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), dirty && submit())}>
            <label>Title<input disabled={!edit} required maxLength={200} value={f.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <div className="two">
              <label>Value ({d.currency})<input disabled={!edit} type="number" min={0} step="any" value={f.value} onChange={(e) => set({ value: e.target.value })} /></label>
              <label>Expected close<input disabled={!edit} type="date" value={f.expected_close} onChange={(e) => set({ expected_close: e.target.value })} /></label>
            </div>
            <OwnerSelect me={me} value={f.owner_id} currentName={d.owner_name} disabled={!edit} onChange={(v) => set({ owner_id: v })} />
            {d.account_visible && (
              <label>
                Contact
                <select disabled={!edit} value={f.contact_id} onChange={(e) => set({ contact_id: e.target.value })}>
                  <option value="">No one in particular</option>
                  {(contacts.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label>Notes<textarea disabled={!edit} rows={3} maxLength={5000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
            <ErrorLine error={save.error} />
            {edit && (
              <div className="dialog-actions">
                <button type="button" className="ghost danger-text" onClick={() => confirm(`Delete “${d.title}”? Its history goes with it.`) && remove.mutate()}><Trash2 size={14} /> Delete</button>
                <button type="submit" disabled={!dirty || save.isPending}>Save changes</button>
              </div>
            )}
            <ErrorLine error={remove.error} />
          </form>
          <p className="muted small">
            Created {formatDay(d.created_at)} · in this stage {d.days_in_stage} day{d.days_in_stage === 1 ? "" : "s"}{d.closed_at ? ` · closed ${formatDay(d.closed_at)}` : ""}
          </p>
        </section>

        <div>
          <FollowUpsPanel target={{ deal_id: d.id }} followups={d.followups} />
          <ActivityPanel target={{ deal_id: d.id }} activities={d.activities} canEdit={edit} />
        </div>
      </div>

      {losing && <LostDialog title={d.title} busy={save.isPending} error={save.error} onClose={() => setLosing(null)} onConfirm={(reason) => save.mutate({ stage_id: losing.id, lost_reason: reason })} />}
    </div>
  );
}
