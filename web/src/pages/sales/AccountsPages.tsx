import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, Plus, Trash2 } from "lucide-react";
import { salesApi, type AccountDetail, type AccountStatus } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { NewAccountDialog, NewContactDialog } from "../../components/sales/AccountDialogs";
import { ActivityPanel, FollowUpsPanel } from "../../components/sales/ActivityPanel";
import { Chip, ErrorLine, OwnerSelect } from "../../components/sales/bits";
import { NewDealDialog } from "../../components/sales/DealDialogs";
import { formatMoney } from "../../lib/money";
import { formatDay, useRefreshSales, useSales } from "../../lib/sales";

const STATUS_LABEL: Record<AccountStatus, string> = { prospect: "Prospect", customer: "Customer", churned: "Churned" };
const STATUS_COLOR: Record<AccountStatus, string> = { prospect: "#2563eb", customer: "#16a34a", churned: "#94a3b8" };

export function AccountsPage() {
  const { workspaceId: wid, me, pipelines } = useSales();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [creating, setCreating] = useState(false);
  const accounts = useQuery({
    queryKey: ["sales", "accounts", wid, { search, status, owner }],
    queryFn: () => salesApi.accounts(wid, { ...(search.trim() ? { q: search.trim() } : {}), ...(status ? { status } : {}), ...(owner ? { owner_id: Number(owner) } : {}) }),
  });
  const cur = pipelines[0]?.currency ?? "USD";
  return (
    <div>
      <div className="filters">
        <input type="search" placeholder="Search accounts" aria-label="Search accounts" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="inline-select">
          <span className="visually-hidden">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {(Object.keys(STATUS_LABEL) as AccountStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </label>
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
        <button type="button" onClick={() => setCreating(true)}><Plus size={16} /> New account</button>
      </div>
      {accounts.error && <p className="alert" role="alert">{accounts.error.message}</p>}
      {accounts.data && accounts.data.length === 0 && <EmptyState icon={<Building2 size={24} />} title="No accounts yet">Accounts are the companies you sell to. They appear here when you qualify a lead or add one by hand.</EmptyState>}
      {!!accounts.data?.length && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Status</th><th>Owner</th><th className="num">Contacts</th><th className="num">Open deals</th></tr></thead>
            <tbody>
              {accounts.data.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/sales/${wid}/accounts/${a.id}`}>{a.name}</Link>{(a.industry || a.website) && <div className="muted small">{[a.industry, a.website].filter(Boolean).join(" · ")}</div>}</td>
                  <td><Chip color={STATUS_COLOR[a.status]}>{STATUS_LABEL[a.status]}</Chip></td>
                  <td>{a.owner_name ?? <span className="muted">Unassigned</span>}</td>
                  <td className="num">{a.contact_count}</td>
                  <td className="num">{a.open_deals}{a.open_deals > 0 && <span className="muted small"> · {formatMoney(a.open_value, cur)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewAccountDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

interface Draft { name: string; website: string; industry: string; size: string; phone: string; status: AccountStatus; notes: string; owner_id: number | null }
const draftOf = (a: AccountDetail): Draft => ({ name: a.name, website: a.website, industry: a.industry, size: a.size, phone: a.phone, status: a.status, notes: a.notes, owner_id: a.owner_id });

export function AccountPage() {
  const id = Number(useParams().id);
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const account = useQuery({ queryKey: ["sales", "account", id], queryFn: () => salesApi.account(id) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [addingDeal, setAddingDeal] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const save = useMutation({ mutationFn: (b: Record<string, unknown>) => salesApi.updateAccount(id, b), onSuccess: async () => (setDraft(null), refresh()) });
  const remove = useMutation({ mutationFn: () => salesApi.deleteAccount(id), onSuccess: async () => (await refresh(), navigate(`/sales/${wid}/accounts`)) });

  if (account.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (account.error || !account.data) return <p className="alert" role="alert">{account.error?.message ?? "Account not found"}</p>;
  const a = account.data;
  const edit = a.can_edit;
  const f = draft ?? draftOf(a);
  const set = (patch: Partial<Draft>) => setDraft({ ...f, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(a));
  const submit = () => {
    const body: Record<string, unknown> = {};
    for (const k of ["name", "website", "industry", "size", "phone", "status", "notes"] as const) if (f[k] !== a[k]) body[k] = f[k];
    if (f.owner_id !== a.owner_id) body.owner_id = f.owner_id;
    if (Object.keys(body).length) save.mutate(body);
  };

  return (
    <div className="record-page">
      <p><Link className="back" to={`/sales/${wid}/accounts`}><ArrowLeft size={14} /> Accounts</Link></p>
      <header className="record-head">
        <div>
          <h2>{a.name}</h2>
          <p className="muted">{[a.industry, a.size, a.website].filter(Boolean).join(" · ") || "No details yet"}</p>
        </div>
        <Chip color={STATUS_COLOR[a.status]}>{STATUS_LABEL[a.status]}</Chip>
      </header>
      {!edit && <p className="muted small">You can see this account but not change it.</p>}

      <div className="pm-grid">
        <section className="panel" aria-label="Details">
          <h2>Details</h2>
          <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), dirty && submit())}>
            <label>Company<input disabled={!edit} required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <div className="two">
              <label>Website<input disabled={!edit} maxLength={200} value={f.website} onChange={(e) => set({ website: e.target.value })} /></label>
              <label>Industry<input disabled={!edit} maxLength={100} value={f.industry} onChange={(e) => set({ industry: e.target.value })} /></label>
            </div>
            <div className="two">
              <label>Size<input disabled={!edit} maxLength={50} value={f.size} onChange={(e) => set({ size: e.target.value })} /></label>
              <label>Phone<input disabled={!edit} maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
            </div>
            <div className="two">
              <label>
                Status
                <select disabled={!edit} value={f.status} onChange={(e) => set({ status: e.target.value as AccountStatus })}>
                  {(Object.keys(STATUS_LABEL) as AccountStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </label>
              <OwnerSelect me={me} value={f.owner_id} currentName={a.owner_name} disabled={!edit} onChange={(v) => set({ owner_id: v })} />
            </div>
            <label>Notes<textarea disabled={!edit} rows={3} maxLength={5000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
            <ErrorLine error={save.error} />
            {edit && (
              <div className="dialog-actions">
                <button type="button" className="ghost danger-text" onClick={() => confirm(`Delete ${a.name}?`) && remove.mutate()}><Trash2 size={14} /> Delete</button>
                <button type="submit" disabled={!dirty || save.isPending}>Save changes</button>
              </div>
            )}
            <ErrorLine error={remove.error} />
          </form>
        </section>

        <div>
          <section className="panel-section" aria-label="Contacts">
            <h3>Contacts <span className="count">{a.contacts.length}</span>{edit && <button type="button" className="link push" onClick={() => setAddingContact(true)}>+ Add</button>}</h3>
            {a.contacts.length === 0 && <p className="muted small">No contacts yet.</p>}
            <ul className="plain-list">
              {a.contacts.map((c) => (
                <li key={c.id}>
                  <Link to={`/sales/${wid}/contacts/${c.id}`}>{c.name}</Link>
                  <span className="muted small">{[c.job_title, c.email, c.phone].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel-section" aria-label="Deals">
            <h3>Deals <span className="count">{a.deals.length}</span><button type="button" className="link push" onClick={() => setAddingDeal(true)}>+ New deal</button></h3>
            {a.deals.length === 0 && <p className="muted small">No deals you can see.</p>}
            <ul className="plain-list">
              {a.deals.map((d) => (
                <li key={d.id}>
                  <Link to={`/sales/${wid}/deals/${d.id}`}>{d.title}</Link>
                  <Chip color={d.stage_color}>{d.stage_name}</Chip>
                  <span className="muted small">{d.value !== null ? formatMoney(d.value, d.currency) : ""}{d.owner_name ? ` · ${d.owner_name}` : ""}{d.stage_kind === "open" && d.expected_close ? ` · closes ${formatDay(d.expected_close)}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>

          <FollowUpsPanel target={{ account_id: a.id }} followups={a.followups} />
          <ActivityPanel target={{ account_id: a.id }} activities={a.activities} canEdit={edit} showWhere />
        </div>
      </div>
      {addingDeal && <NewDealDialog accountId={a.id} onClose={() => setAddingDeal(false)} />}
      {addingContact && <NewContactDialog accountId={a.id} onClose={() => setAddingContact(false)} />}
    </div>
  );
}
