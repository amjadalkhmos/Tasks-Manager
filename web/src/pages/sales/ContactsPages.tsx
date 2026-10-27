import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Users } from "lucide-react";
import { salesApi, type ContactDetail } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { NewContactDialog } from "../../components/sales/AccountDialogs";
import { ActivityPanel } from "../../components/sales/ActivityPanel";
import { Chip, ErrorLine, OwnerSelect } from "../../components/sales/bits";
import { formatMoney } from "../../lib/money";
import { useRefreshSales, useSales } from "../../lib/sales";

export function ContactsPage() {
  const { workspaceId: wid, me } = useSales();
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [creating, setCreating] = useState(false);
  const contacts = useQuery({
    queryKey: ["sales", "contacts", wid, { search, owner }],
    queryFn: () => salesApi.contacts(wid, { ...(search.trim() ? { q: search.trim() } : {}), ...(owner ? { owner_id: Number(owner) } : {}) }),
  });
  return (
    <div>
      <div className="filters">
        <input type="search" placeholder="Search contacts" aria-label="Search contacts" value={search} onChange={(e) => setSearch(e.target.value)} />
        {me.owners.length > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Everyone I can see</option>
              {me.owners.map((p) => <option key={p.id} value={p.id}>{p.id === me.user_id ? `${p.name} (you)` : p.name}</option>)}
            </select>
          </label>
        )}
        <span className="grow" />
        <button type="button" onClick={() => setCreating(true)}><Plus size={16} /> New contact</button>
      </div>
      {contacts.error && <p className="alert" role="alert">{contacts.error.message}</p>}
      {contacts.data && contacts.data.length === 0 && <EmptyState icon={<Users size={24} />} title="No contacts yet">People you deal with appear here, grouped under their company's account.</EmptyState>}
      {!!contacts.data?.length && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Account</th><th>Email</th><th>Phone</th><th>Owner</th></tr></thead>
            <tbody>
              {contacts.data.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/sales/${wid}/contacts/${c.id}`}>{c.name}</Link>{c.job_title && <div className="muted small">{c.job_title}</div>}</td>
                  <td>{c.account_id ? <Link to={`/sales/${wid}/accounts/${c.account_id}`}>{c.account_name}</Link> : <span className="muted">—</span>}</td>
                  <td>{c.email || "—"}</td>
                  <td>{c.phone || "—"}</td>
                  <td>{c.owner_name ?? <span className="muted">Unassigned</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewContactDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

interface Draft { name: string; email: string; phone: string; job_title: string; notes: string; owner_id: number | null }
const draftOf = (c: ContactDetail): Draft => ({ name: c.name, email: c.email, phone: c.phone, job_title: c.job_title, notes: c.notes, owner_id: c.owner_id });

export function ContactPage() {
  const id = Number(useParams().id);
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const contact = useQuery({ queryKey: ["sales", "contact", id], queryFn: () => salesApi.contact(id) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const save = useMutation({ mutationFn: (b: Record<string, unknown>) => salesApi.updateContact(id, b), onSuccess: async () => (setDraft(null), refresh()) });
  const remove = useMutation({ mutationFn: () => salesApi.deleteContact(id), onSuccess: async () => (await refresh(), navigate(`/sales/${wid}/contacts`)) });

  if (contact.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (contact.error || !contact.data) return <p className="alert" role="alert">{contact.error?.message ?? "Contact not found"}</p>;
  const c = contact.data;
  const edit = c.can_edit;
  const f = draft ?? draftOf(c);
  const set = (patch: Partial<Draft>) => setDraft({ ...f, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(c));
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const k of ["name", "email", "phone", "job_title", "notes"] as const) if (f[k] !== c[k]) body[k] = f[k];
    if (f.owner_id !== c.owner_id) body.owner_id = f.owner_id;
    if (Object.keys(body).length) save.mutate(body);
  };

  return (
    <div className="record-page">
      <p><Link className="back" to={`/sales/${wid}/contacts`}><ArrowLeft size={14} /> Contacts</Link></p>
      <header className="record-head">
        <div>
          <h2>{c.name}</h2>
          <p className="muted">
            {c.job_title || "Contact"}
            {c.account_id && <> · <Link to={`/sales/${wid}/accounts/${c.account_id}`}>{c.account_name}</Link></>}
          </p>
        </div>
      </header>
      {!edit && <p className="muted small">You can see this contact but not change it.</p>}
      <div className="pm-grid">
        <section className="panel" aria-label="Details">
          <h2>Details</h2>
          <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), dirty && submit())}>
            <div className="two">
              <label>Name<input disabled={!edit} required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <label>Email<input disabled={!edit} type="email" maxLength={200} value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
            </div>
            <div className="two">
              <label>Phone<input disabled={!edit} maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
              <label>Job title<input disabled={!edit} maxLength={100} value={f.job_title} onChange={(e) => set({ job_title: e.target.value })} /></label>
            </div>
            {c.account_id === null ? (
              <OwnerSelect me={me} value={f.owner_id} currentName={c.owner_name} disabled={!edit} onChange={(v) => set({ owner_id: v })} />
            ) : (
              <p className="muted small">Owned by {c.owner_name ?? "nobody"}, like its account.</p>
            )}
            <label>Notes<textarea disabled={!edit} rows={3} maxLength={5000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
            <ErrorLine error={save.error} />
            {edit && (
              <div className="dialog-actions">
                <button type="button" className="ghost danger-text" onClick={() => confirm(`Delete ${c.name}?`) && remove.mutate()}><Trash2 size={14} /> Delete</button>
                <button type="submit" disabled={!dirty || save.isPending}>Save changes</button>
              </div>
            )}
            <ErrorLine error={remove.error} />
          </form>
        </section>
        <div>
          {c.deals.length > 0 && (
            <section className="panel-section" aria-label="Deals">
              <h3>Deals <span className="count">{c.deals.length}</span></h3>
              <ul className="plain-list">
                {c.deals.map((d) => (
                  <li key={d.id}>
                    <Link to={`/sales/${wid}/deals/${d.id}`}>{d.title}</Link>
                    <Chip color={d.stage_color}>{d.stage_name}</Chip>
                    {d.value !== null && <span className="muted small">{formatMoney(d.value, d.currency)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ActivityPanel target={{ contact_id: c.id }} activities={c.activities} canEdit={edit} />
        </div>
      </div>
    </div>
  );
}
