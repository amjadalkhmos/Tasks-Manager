import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Inbox, TriangleAlert } from "lucide-react";
import { salesApi } from "../../api";
import { ForecastPanel } from "../../components/ForecastPanel";
import { formatMoney } from "../../lib/money";
import { formatDay, useSales } from "../../lib/sales";

/** Where the pipeline stands for the records this person can see, and what needs a hand. */
export function OverviewPage() {
  const { workspaceId: wid, me, pipelines } = useSales();
  const [pipelineId, setPipelineId] = useState<number | undefined>(undefined);
  const [ownerId, setOwnerId] = useState<number | undefined>(undefined);
  const view = useQuery({ queryKey: ["sales", "overview", wid, pipelineId, ownerId], queryFn: () => salesApi.overview(wid, pipelineId, ownerId) });
  const follow = useQuery({ queryKey: ["sales", "my-followups", wid], queryFn: () => salesApi.myFollowUps(wid) });

  const o = view.data;
  const currency = o?.pipeline?.currency ?? "USD";
  const cur = (n: number) => formatMoney(n, currency);
  const owners = me.owners.length > 1 || me.manager ? me.owners : [];

  return (
    <div>
      {view.error && <p className="alert" role="alert">{view.error.message}</p>}

      <div className="filters">
        {pipelines.length > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Pipeline</span>
            <select value={o?.pipeline?.id ?? ""} onChange={(e) => setPipelineId(Number(e.target.value))}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {owners.length > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Owner</span>
            <select value={ownerId ?? ""} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">Everyone I can see</option>
              {owners.map((p) => <option key={p.id} value={p.id}>{p.id === me.user_id ? `${p.name} (you)` : p.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {o && o.leads.inbox !== null && o.leads.inbox > 0 && (
        <Link className="inbox-banner" to={`/sales/${wid}/leads?view=inbox`}>
          <Inbox size={16} /> <strong>{o.leads.inbox}</strong> lead{o.leads.inbox === 1 ? "" : "s"} waiting in the inbox for someone to take {o.leads.inbox === 1 ? "it" : "them"}.
        </Link>
      )}

      {o?.forecast && o.pipeline ? (
        <ForecastPanel f={{ currency, ...o.forecast }} />
      ) : (
        o && <p className="muted">Add a pipeline in Settings to start tracking deals.</p>
      )}

      {o && (
        <div className="pm-grid">
          <section className="panel" aria-label="Leads">
            <h2>Leads</h2>
            <div className="mini-stats">
              <div><strong>{o.leads.new}</strong><span>new</span></div>
              <div><strong>{o.leads.working}</strong><span>being worked</span></div>
              <div><strong>{o.leads.qualified}</strong><span>qualified</span></div>
              <div><strong>{o.leads.disqualified}</strong><span>disqualified</span></div>
            </div>
            <p className="row-inline"><Link to={`/sales/${wid}/leads`}>Open the leads list</Link></p>
          </section>

          <section className="panel" aria-label="Sales cycle">
            <h2>Deals</h2>
            <div className="mini-stats">
              <div><strong>{o.avg_cycle_days === null || o.avg_cycle_days === undefined ? "—" : `${o.avg_cycle_days}d`}</strong><span>average time to win</span></div>
              <div><strong className={o.overdue_count ? "late" : ""}>{o.overdue_count ?? 0}</strong><span>past expected close</span></div>
              <div><strong className={o.stalled?.length ? "late" : ""}>{o.stalled?.length ?? 0}</strong><span>stalled {o.stalled_days}+ days</span></div>
            </div>
            {!!o.stalled?.length && (
              <ul className="plain-list">
                {o.stalled.map((d) => (
                  <li key={d.id}>
                    <TriangleAlert size={14} className="late" />
                    <Link to={`/sales/${wid}/deals/${d.id}`}>{d.title}</Link>
                    <span className="muted small">{d.value !== null ? cur(d.value) : ""} · quiet for {d.days} days</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!!o.by_owner && o.by_owner.length > 1 && (
            <section className="panel span-2" aria-label="By owner">
              <h2>By owner</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Owner</th><th className="num">Open deals</th><th className="num">Open value</th><th className="num">Weighted</th><th className="num">Won</th></tr></thead>
                  <tbody>
                    {o.by_owner.map((r) => (
                      <tr key={r.owner_id ?? "none"}>
                        <td>{r.owner_name}</td>
                        <td className="num">{r.open_count}</td>
                        <td className="num">{cur(r.open_value)}</td>
                        <td className="num">{cur(r.weighted_value)}</td>
                        <td className="num">{cur(r.won_value)}<span className="muted small"> · {r.won_count}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="panel span-2" aria-label="My follow-ups">
            <h2>My follow-ups</h2>
            {follow.data && follow.data.length === 0 && <p className="muted small">Nothing planned. Add a follow-up from any lead, deal or account.</p>}
            <ul className="plain-list">
              {(follow.data ?? []).map((f) => (
                <li key={f.id}>
                  <span>{f.title}</span>
                  {f.about && (
                    <Link className="muted small" to={f.deal_id ? `/sales/${wid}/deals/${f.deal_id}` : f.lead_id ? `/sales/${wid}/leads/${f.lead_id}` : `/sales/${wid}/accounts/${f.account_id}`}>{f.about}</Link>
                  )}
                  {f.due_at && <span className={`muted small${Date.parse(f.due_at) < Date.now() ? " late" : ""}`}>{formatDay(f.due_at)}</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
