import { useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { salesApi } from "../../api";
import { SalesProvider } from "../../lib/sales";
import { AccountPage, AccountsPage } from "./AccountsPages";
import { ContactPage, ContactsPage } from "./ContactsPages";
import { DealPage } from "./DealPage";
import { LeadPage, LeadsPage } from "./LeadsPages";
import { OverviewPage } from "./OverviewPage";
import { PipelinePage } from "./PipelinePage";
import { SalesSettingsPage } from "./SalesSettingsPage";

/** /sales: opens the first workspace where Sales is switched on for the signed-in person. */
export function SalesHome() {
  const spaces = useQuery({ queryKey: ["sales", "workspaces"], queryFn: salesApi.workspaces });
  if (spaces.isLoading) return <p className="muted" role="status">Loading…</p>;
  const first = spaces.data?.[0];
  if (!first) {
    return (
      <div className="empty">
        <h2>Sales isn't switched on for you</h2>
        <p>An owner or admin of your workspace can give you access, and choose whose leads, accounts and deals you can see.</p>
      </div>
    );
  }
  return <Navigate to={`/sales/${first.id}`} replace />;
}

/** Everything under /sales/:workspaceId: the header and tabs, and the pages themselves. */
export function SalesLayout() {
  const wid = Number(useParams().wid);
  const navigate = useNavigate();
  const spaces = useQuery({ queryKey: ["sales", "workspaces"], queryFn: salesApi.workspaces });
  const me = useQuery({ queryKey: ["sales", "me", wid], queryFn: () => salesApi.me(wid), enabled: Number.isFinite(wid) });

  useEffect(() => {
    if (me.data && !me.data.enabled) void spaces.refetch();
  }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!Number.isFinite(wid)) return <Navigate to="/sales" replace />;
  if (me.isLoading) return <p className="muted" role="status">Loading…</p>;
  if (me.error) return <p className="alert" role="alert">{me.error.message}</p>;
  if (!me.data?.enabled) {
    return (
      <div className="empty">
        <h2>Sales isn't switched on for you here</h2>
        <p>An owner or admin of this workspace can give you access, and choose whose leads, accounts and deals you can see.</p>
      </div>
    );
  }

  const data = me.data;
  const current = spaces.data?.find((s) => s.id === wid);
  const tab = (to: string, label: string, end = false) => <NavLink to={`/sales/${wid}${to}`} end={end}>{label}</NavLink>;

  return (
    <SalesProvider value={{ workspaceId: wid, me: data, pipelines: data.pipelines }}>
      <header className="page-header">
        <div>
          <h1>Sales</h1>
          <p className="sub">
            {current?.name ?? "Workspace"} · {data.manager ? "you can see everything" : `you can see ${data.owners.length} ${data.owners.length === 1 ? "person's" : "people's"} records`}
          </p>
        </div>
        {(spaces.data?.length ?? 0) > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Workspace</span>
            <select value={wid} onChange={(e) => navigate(`/sales/${e.target.value}`)}>
              {spaces.data!.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
      </header>
      <nav className="salesbar" aria-label="Sales">
        {tab("", "Overview", true)}
        {tab("/pipeline", "Pipeline")}
        {tab("/leads", "Leads")}
        {tab("/accounts", "Accounts")}
        {tab("/contacts", "Contacts")}
        {data.manager && tab("/settings", "Settings")}
      </nav>
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="leads" element={<LeadsPage />} />
        <Route path="leads/:id" element={<LeadPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="accounts/:id" element={<AccountPage />} />
        <Route path="contacts" element={<ContactsPage />} />
        <Route path="contacts/:id" element={<ContactPage />} />
        <Route path="deals/:id" element={<DealPage />} />
        <Route path="settings" element={data.manager ? <SalesSettingsPage /> : <Navigate to={`/sales/${wid}`} replace />} />
        <Route path="*" element={<Navigate to={`/sales/${wid}`} replace />} />
      </Routes>
    </SalesProvider>
  );
}
