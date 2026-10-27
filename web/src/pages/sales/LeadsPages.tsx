import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Inbox, Plus, Trash2, Upload, UserRoundCheck } from "lucide-react";
import { salesApi, type Lead, type LeadDetail, type LeadStatus } from "../../api";
import { ActivityPanel, FollowUpsPanel } from "../../components/sales/ActivityPanel";
import { Chip, ErrorLine, OwnerSelect } from "../../components/sales/bits";
import { ImportDialog, NewLeadDialog, QualifyDialog } from "../../components/sales/LeadDialogs";
import { EmptyState } from "../../components/EmptyState";
import { canEditOwner, formatDay, useRefreshSales, useSales } from "../../lib/sales";
import { timeAgo } from "../../lib/time";

const STATUS_LABEL: Record<LeadStatus, string> = { new: "New", working: "Working", qualified: "Qualified", disqualified: "Disqualified" };
const STATUS_COLOR: Record<LeadStatus, string> = { new: "#2563eb", working: "#a855f7", qualified: "#16a34a", disqualified: "#94a3b8" };
const SOURCE_LABEL: Record<Lead["source"], string> = { manual: "Added by hand", form: "Web form", import: "Imported", other: "Other" };

type View = "open" | "inbox" | "qualified" | "disqualified" | "all";

export function LeadsPage() {
  const { workspaceId: wid, me } = useSales();
  const refresh = useRefreshSales();
  const [params, setParams] = useSearchParams();
  const view = (params.get("view") as View | null) ?? "open";
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const leads = useQuery({
    queryKey: ["sales", "leads", wid, view, owner, search],
    queryFn: () =>
      salesApi.leads(wid, {
        status: view === "inbox" ? "open" : view,
        ...(view === "inbox" ? { unassigned: true } : owner ? { owner_id: Number(owner) } : {}),
        ...(search.trim() ? { q: search.trim() } : {}),
      }),
  });
  const take = useMutation({ mutationFn: (id: number) => salesApi.updateLead(id, { owner_id: me.user_id }), onSuccess: refresh });
  const canTake = me.assignable.owners.some((o) => o.id === me.user_id);
  const views: { id: View; label: string }[] = [
    { id: "open", label: "Open" },
    ...(me.unassigned ? [{ id: "inbox" as const, label: "Inbox" }] : []),
    { id: "qualified", label: "Qualified" },
    { id: "disqualified", label: "Disqualified" },
    { id: "all", label: "All" },
  ];
  const people = me.owners;

  return (
    <div>
      <div className="filters">
        <div className="segmented" role="radiogroup" aria-label="Show">
          {views.map((v) => (
            <button key={v.id} type="button" role="radio" aria-checked={view === v.id} className={view === v.id ? "on" : ""} onClick={() => setParams(v.id === "open" ? {} : { view: v.id })}>
              {v.id === "inbox" && <Inbox size={13} />} {v.label}
            </button>
          ))}
        </div>
        {view !== "inbox" && people.length > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Everyone I can see</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.user_id ? `${p.name} (you)` : p.name}</option>)}
            </select>
          </label>
        )}
        <input type="search" placeholder="Search leads" aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        <button type="button" className="secondary" onClick={() => setImporting(true)}><Upload size={15} /> Import CSV</button>
        <button type="button" onClick={() => setCreating(true)}><Plus size={16} /> New lead</button>
      </div>
      {(leads.error ?? take.error) && <p className="alert" role="alert">{(leads.error ?? take.error)!.message}</p>}
      {view === "inbox" && <p className="muted small">New leads from your web forms land here until someone takes them.</p>}

      {leads.data && leads.data.length === 0 && (
        <EmptyState icon={<UserRoundCheck size={24} />} title={view === "inbox" ? "The inbox is empty" : "No leads here"}>
          {view === "inbox" ? "Leads from your web form and unowned imports show up here." : "Add a lead by hand, import a spreadsheet, or share your web form."}
        </EmptyState>
      )}
      {!!leads.data?.length && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Company</th><th>Source</th><th>Owner</th><th>Status</th><th>Added</th><th /></tr></thead>
            <tbody>
              {leads.data.map((l) => (
                <tr key={l.id}>
                  <td><Link to={`/sales/${wid}/leads/${l.id}`}>{l.name}</Link>{l.email && <div className="muted small">{l.email}</div>}</td>
                  <td>{l.company || "—"}</td>
                  <td className="muted small">{SOURCE_LABEL[l.source]}{l.source_detail ? ` · ${l.source_detail}` : ""}</td>
                  <td>{l.owner_name ?? <span className="muted">Unassigned</span>}</td>
                  <td><Chip color={STATUS_COLOR[l.status]}>{STATUS_LABEL[l.status]}</Chip></td>
                  <td className="muted small" title={formatDay(l.created_at)}>{timeAgo(l.created_at)}</td>
                  <td className="num">
                    {l.owner_id === null && canTake && canEditOwner(me, null) && (l.status === "new" || l.status === "working") && (
                      <button type="button" className="secondary" disabled={take.isPending} onClick={() => take.mutate(l.id)}>Take</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewLeadDialog onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

interface Draft { name: string; email: string; phone: string; company: string; job_title: string; notes: string; owner_id: number | null }
const draftOf = (l: LeadDetail): Draft => ({ name: l.name, email: l.email, phone: l.phone, company: l.company, job_title: l.job_title, notes: l.notes, owner_id: l.owner_id });

export function LeadPage() {
  const id = Number(useParams().id);
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const lead = useQuery({ queryKey: ["sales", "lead", id], queryFn: () => salesApi.lead(id) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [qualifying, setQualifying] = useState(false);

  const save = useMutation({ mutationFn: (b: Record<string, unknown>) => salesApi.updateLead(id, b), onSuccess: async () => (setDraft(null), refresh()) });
  const disqualify = useMutation({ mutationFn: (reason: string) => salesApi.disqualifyLead(id, reason), onSuccess: refresh });
  const reopen = useMutation({ mutationFn: () => salesApi.reopenLead(id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => salesApi.deleteLead(id), onSuccess: async () => (await refresh(), navigate(`/sales/${wid}/leads`)) });

  if (lead.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (lead.error || !lead.data) return <p className="alert" role="alert">{lead.error?.message ?? "Lead not found"}</p>;
  const l = lead.data;
  const closed = l.status === "qualified" || l.status === "disqualified";
  const edit = l.can_edit;
  const f = draft ?? draftOf(l);
  const set = (patch: Partial<Draft>) => setDraft({ ...f, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(l));
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const k of ["name", "email", "phone", "company", "job_title", "notes"] as const) if (f[k] !== l[k]) body[k] = f[k];
    if (f.owner_id !== l.owner_id) body.owner_id = f.owner_id;
    if (Object.keys(body).length) save.mutate(body);
  };
  const askDisqualify = () => {
    const reason = prompt("Why isn't this lead a fit?", "");
    if (reason?.trim()) disqualify.mutate(reason.trim());
  };

  return (
    <div className="record-page">
      <p><Link className="back" to={`/sales/${wid}/leads`}><ArrowLeft size={14} /> Leads</Link></p>
      <header className="record-head">
        <div>
          <h2>{l.name}</h2>
          <p className="muted">{[l.job_title, l.company].filter(Boolean).join(" at ") || "No company yet"} · {SOURCE_LABEL[l.source]}{l.source_detail ? ` (${l.source_detail})` : ""} · added {timeAgo(l.created_at)}</p>
        </div>
        <Chip color={STATUS_COLOR[l.status]}>{STATUS_LABEL[l.status]}</Chip>
      </header>

      {l.status === "qualified" && (
        <p className="alert ok">
          Qualified.{" "}
          {l.deal_id && <Link to={`/sales/${wid}/deals/${l.deal_id}`}>Open the deal</Link>}
          {l.deal_id && l.account_id && " · "}
          {l.account_id && <Link to={`/sales/${wid}/accounts/${l.account_id}`}>Open the account</Link>}
          {l.contact_id && <> · <Link to={`/sales/${wid}/contacts/${l.contact_id}`}>Open the contact</Link></>}
        </p>
      )}
      {l.status === "disqualified" && <p className="alert">Disqualified: {l.disqualified_reason || "no reason given"}</p>}
      {!edit && <p className="muted small">You can see this lead but not change it.</p>}

      {edit && !closed && (
        <div className="row-inline" style={{ marginBottom: 16 }}>
          <button type="button" onClick={() => setQualifying(true)}>Qualify…</button>
          <button type="button" className="secondary" disabled={disqualify.isPending} onClick={askDisqualify}>Not a fit</button>
        </div>
      )}
      {edit && l.status === "disqualified" && <p><button type="button" className="secondary" disabled={reopen.isPending} onClick={() => reopen.mutate()}>Reopen</button></p>}
      <ErrorLine error={disqualify.error ?? reopen.error} />

      <div className="pm-grid">
        <section className="panel" aria-label="Details">
          <h2>Details</h2>
          <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), dirty && submit())}>
            <div className="two">
              <label>Name<input disabled={!edit || closed} required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <label>Email<input disabled={!edit || closed} type="email" maxLength={200} value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
            </div>
            <div className="two">
              <label>Company<input disabled={!edit || closed} maxLength={200} value={f.company} onChange={(e) => set({ company: e.target.value })} /></label>
              <label>Job title<input disabled={!edit || closed} maxLength={100} value={f.job_title} onChange={(e) => set({ job_title: e.target.value })} /></label>
            </div>
            <div className="two">
              <label>Phone<input disabled={!edit || closed} maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
              <OwnerSelect me={me} value={f.owner_id} currentName={l.owner_name} disabled={!edit} onChange={(v) => set({ owner_id: v })} />
            </div>
            <label>Notes<textarea disabled={!edit} rows={3} maxLength={5000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
            <ErrorLine error={save.error} />
            {edit && (
              <div className="dialog-actions">
                <button type="button" className="ghost danger-text" onClick={() => confirm(`Delete ${l.name}? This can't be undone.`) && remove.mutate()}><Trash2 size={14} /> Delete</button>
                <button type="submit" disabled={!dirty || save.isPending}>Save changes</button>
              </div>
            )}
          </form>
        </section>
        <div>
          <FollowUpsPanel target={{ lead_id: l.id }} followups={l.followups} />
          <ActivityPanel target={{ lead_id: l.id }} activities={l.activities} canEdit={edit} />
        </div>
      </div>
      {qualifying && <QualifyDialog lead={l} onClose={() => setQualifying(false)} />}
    </div>
  );
}
