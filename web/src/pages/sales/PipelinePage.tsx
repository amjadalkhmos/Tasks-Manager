import { useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock, Plus, TriangleAlert } from "lucide-react";
import { salesApi, type Deal, type SalesStage } from "../../api";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { LostDialog, NewDealDialog } from "../../components/sales/DealDialogs";
import { formatMoney } from "../../lib/money";
import { canEditOwner, formatDay, useRefreshSales, useSales } from "../../lib/sales";

const CLOSED_SHOWN = 15;

/** The deals of one pipeline as columns, one per stage. Drag a card (or use the arrows) to move it on. */
export function PipelinePage() {
  const { workspaceId: wid, me, pipelines } = useSales();
  const refresh = useRefreshSales();
  const [params, setParams] = useSearchParams();
  const pipeline = pipelines.find((p) => p.id === Number(params.get("pipeline"))) ?? pipelines[0];
  const owner = params.get("owner") ?? "";
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStage, setOverStage] = useState<number | null>(null);
  const [losing, setLosing] = useState<{ deal: Deal; stage: SalesStage } | null>(null);

  const deals = useQuery({
    queryKey: ["sales", "deals", wid, pipeline?.id, owner, search],
    queryFn: () => salesApi.deals(wid, { pipeline_id: pipeline!.id, ...(owner === "none" ? { unassigned: true } : owner ? { owner_id: Number(owner) } : {}), ...(search.trim() ? { q: search.trim() } : {}) }),
    enabled: !!pipeline,
  });
  const move = useMutation({
    mutationFn: (v: { id: number; stage_id: number; lost_reason?: string }) => salesApi.updateDeal(v.id, { stage_id: v.stage_id, ...(v.lost_reason !== undefined ? { lost_reason: v.lost_reason } : {}) }),
    onSuccess: async () => {
      setLosing(null);
      await refresh();
    },
  });

  if (!pipeline) return <EmptyState icon={<Plus size={24} />} title="No pipeline yet">Ask an admin to set one up in Settings.</EmptyState>;

  const all = deals.data ?? [];
  const drop = (stage: SalesStage) => {
    const d = all.find((x) => x.id === dragId);
    setDragId(null);
    setOverStage(null);
    if (!d || d.stage_id === stage.id || !canEditOwner(me, d.owner_id)) return;
    if (stage.kind === "lost") setLosing({ deal: d, stage });
    else move.mutate({ id: d.id, stage_id: stage.id });
  };
  const step = (d: Deal, dir: -1 | 1) => {
    const i = pipeline.stages.findIndex((s) => s.id === d.stage_id);
    const next = pipeline.stages[i + dir];
    if (!next) return;
    if (next.kind === "lost") setLosing({ deal: d, stage: next });
    else move.mutate({ id: d.id, stage_id: next.id });
  };
  const cur = (n: number) => formatMoney(n, pipeline.currency);
  const people = me.manager ? me.owners : me.owners;

  return (
    <div>
      <div className="filters">
        {pipelines.length > 1 && (
          <label className="inline-select">
            <span className="visually-hidden">Pipeline</span>
            <select value={pipeline.id} onChange={(e) => setParams({ pipeline: e.target.value })}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {(people.length > 1 || me.unassigned) && (
          <label className="inline-select">
            <span className="visually-hidden">Owner</span>
            <select value={owner} onChange={(e) => { const next = new URLSearchParams(params); if (e.target.value) next.set("owner", e.target.value); else next.delete("owner"); setParams(next); }}>
              <option value="">Everyone I can see</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.id === me.user_id ? `${p.name} (you)` : p.name}</option>)}
              {me.unassigned && <option value="none">Unassigned</option>}
            </select>
          </label>
        )}
        <input type="search" placeholder="Search deals or accounts" aria-label="Search deals" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        <button type="button" onClick={() => setCreating(true)}><Plus size={16} /> New deal</button>
      </div>
      {(deals.error ?? move.error) && <p className="alert" role="alert">{(deals.error ?? move.error)!.message}</p>}

      <div className="board deal-board" style={{ "--cols": pipeline.stages.length } as CSSProperties}>
        {pipeline.stages.map((s, si) => {
          const inStage = all.filter((d) => d.stage_id === s.id);
          const shown = s.kind === "open" ? inStage : [...inStage].sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? "")).slice(0, CLOSED_SHOWN);
          const total = inStage.reduce((n, d) => n + (d.value ?? 0), 0);
          return (
            <div
              key={s.id}
              className={`column${overStage === s.id ? " over" : ""}`}
              onDragOver={(e) => (e.preventDefault(), setOverStage(s.id))}
              onDragLeave={() => setOverStage(null)}
              onDrop={(e) => (e.preventDefault(), drop(s))}
            >
              <h2 className="column-head">
                <span className="dot" style={{ background: s.color }} />
                {s.name}
                <span className="count">{inStage.length}</span>
                <span className="head-sub">
                  {s.kind === "open" && <span className="chance" title="Chance of winning a deal in this stage">{s.probability}%</span>}
                  <span className="deal-value" title="Total value in this stage">{cur(total)}</span>
                </span>
              </h2>
              {shown.map((d) => (
                <article key={d.id} className={`card-task deal-card${dragId === d.id ? " dragging" : ""}`} draggable={canEditOwner(me, d.owner_id)} onDragStart={() => setDragId(d.id)} onDragEnd={() => setDragId(null)}>
                  <Link className="title" to={`/sales/${wid}/deals/${d.id}`}>{d.title}</Link>
                  {d.account_name && <div className="muted small">{d.account_name}</div>}
                  <div className="meta">
                    {d.value !== null && <span className="deal-value">{cur(d.value)}</span>}
                    {d.expected_close && s.kind === "open" && (
                      <span className={d.expected_close < new Date().toISOString().slice(0, 10) ? "overdue" : ""} title="Expected close"><CalendarDays size={13} />{formatDay(d.expected_close)}</span>
                    )}
                    {d.stalled && <span className="overdue" title="Nobody has touched this deal for a while"><TriangleAlert size={13} />stalled</span>}
                    {s.kind === "open" && d.days_in_stage > 0 && <span title="Days in this stage"><Clock size={13} />{d.days_in_stage}d</span>}
                    {d.owner_id !== null && <Avatar id={d.owner_id} name={d.owner_name ?? "?"} size={18} />}
                  </div>
                  {canEditOwner(me, d.owner_id) && (
                    <div className="step">
                      <button type="button" className="icon sm" disabled={si === 0} aria-label="Move to the previous stage" onClick={() => step(d, -1)}>‹</button>
                      <button type="button" className="icon sm" disabled={si === pipeline.stages.length - 1} aria-label="Move to the next stage" onClick={() => step(d, 1)}>›</button>
                    </div>
                  )}
                </article>
              ))}
              {inStage.length > shown.length && <p className="hint">{inStage.length - shown.length} older deal{inStage.length - shown.length === 1 ? "" : "s"} not shown</p>}
              {inStage.length === 0 && <p className="hint">{s.kind === "open" ? "Drop deals here" : s.kind === "won" ? "Won deals land here" : "Lost deals land here"}</p>}
            </div>
          );
        })}
      </div>

      {creating && <NewDealDialog pipelineId={pipeline.id} onClose={() => setCreating(false)} />}
      {losing && (
        <LostDialog
          title={losing.deal.title}
          busy={move.isPending}
          error={move.error}
          onClose={() => setLosing(null)}
          onConfirm={(reason) => move.mutate({ id: losing.deal.id, stage_id: losing.stage.id, lost_reason: reason })}
        />
      )}
    </div>
  );
}
