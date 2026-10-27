import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, RefreshCw, Trash2 } from "lucide-react";
import { ApiError, api, salesApi, type AccessRow, type LeadForm, type SalesLevel, type SalesPipeline, type SalesStage, type StageKind } from "../../api";
import { Dialog, ErrorLine } from "../../components/sales/bits";
import { useRefreshSales, useSales } from "../../lib/sales";

type Tab = "access" | "pipelines" | "forms" | "old";

export function SalesSettingsPage() {
  const [tab, setTab] = useState<Tab>("access");
  const { workspaceId: wid } = useSales();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const legacy = (projects.data ?? []).filter((p) => p.workspace_id === wid && p.type === "pipeline");
  const tabs: [Tab, string][] = [["access", "People and access"], ["pipelines", "Pipelines"], ["forms", "Lead forms"], ...(legacy.length || tab === "old" ? [["old", "Old pipeline projects"] as [Tab, string]] : [])];
  return (
    <div>
      <div className="segmented" role="tablist" aria-label="Sales settings" style={{ marginBottom: 16 }}>
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {tab === "access" && <AccessSection />}
      {tab === "pipelines" && <PipelinesSection />}
      {tab === "forms" && <FormsSection />}
      {tab === "old" && <LegacySection projects={legacy} />}
    </div>
  );
}

// ---------- who can see whose records ----------
const LEVELS: { value: "" | SalesLevel; label: string }[] = [{ value: "", label: "No access" }, { value: "view", label: "Can view" }, { value: "edit", label: "Can edit" }];

function AccessSection() {
  const { workspaceId: wid } = useSales();
  const rows = useQuery({ queryKey: ["sales", "access", wid], queryFn: () => salesApi.access(wid) });
  return (
    <section className="panel" aria-label="People and access">
      <h2>People and access</h2>
      <p className="muted small">
        Switch Sales on for a person, then choose whose records they can see. Everyone sees their own. “Can view” lets them read someone's leads, accounts and deals;
        “Can edit” lets them work on them too. Owners and admins always see everything.
      </p>
      {rows.error && <p className="alert" role="alert">{rows.error.message}</p>}
      <ul className="access-list">
        {(rows.data ?? []).map((r) => <AccessRowEditor key={r.user_id} row={r} everyone={rows.data!} />)}
      </ul>
    </section>
  );
}

function AccessRowEditor({ row, everyone }: { row: AccessRow; everyone: AccessRow[] }) {
  const { workspaceId: wid } = useSales();
  const refresh = useRefreshSales();
  const initial = () => ({
    enabled: row.enabled,
    levels: Object.fromEntries(row.grants.map((g) => [g.owner_id, g.level])) as Record<number, SalesLevel>,
    unassigned: row.unassigned,
  });
  const [draft, setDraft] = useState(initial);
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      salesApi.setAccess(wid, row.user_id, {
        enabled: draft.enabled,
        grants: draft.enabled ? Object.entries(draft.levels).map(([owner, level]) => ({ owner_id: Number(owner), level })) : [],
        unassigned: draft.enabled ? draft.unassigned : null,
      }),
    onSuccess: async () => {
      await refresh();
      setOpen(false);
    },
  });
  const others = everyone.filter((o) => o.user_id !== row.user_id);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial());
  const summary = row.everything
    ? "Sees everything"
    : !row.enabled
      ? "No Sales access"
      : `Sees ${1 + row.grants.length} ${row.grants.length === 0 ? "person's" : "people's"} records${row.unassigned ? " and the inbox" : ""}`;

  return (
    <li>
      <div className="access-head">
        <div>
          <strong>{row.name}</strong> <span className="muted small">{row.role} · {row.email}</span>
          <div className="muted small">{summary}</div>
        </div>
        {!row.everything && <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "Edit access"}</button>}
      </div>
      {open && !row.everything && (
        <div className="access-body">
          <label className="check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Sales is on for {row.name}
          </label>
          {draft.enabled && (
            <>
              <div className="grant-grid">
                {others.map((o) => (
                  <label key={o.user_id}>
                    {o.name}'s records
                    <select value={draft.levels[o.user_id] ?? ""} onChange={(e) => {
                      const next = { ...draft.levels };
                      if (e.target.value) next[o.user_id] = e.target.value as SalesLevel;
                      else delete next[o.user_id];
                      setDraft({ ...draft, levels: next });
                    }}>
                      {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </label>
                ))}
                <label>
                  Unassigned leads (the inbox)
                  <select value={draft.unassigned ?? ""} onChange={(e) => setDraft({ ...draft, unassigned: (e.target.value || null) as SalesLevel | null })}>
                    {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                </label>
              </div>
              {row.role === "viewer" && <p className="muted small">{row.name} is a workspace viewer, so they can only ever view.</p>}
            </>
          )}
          <ErrorLine error={save.error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => (setDraft(initial()), setOpen(false))}>Cancel</button>
            <button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate()}>Save</button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------- pipelines and stages ----------
function PipelinesSection() {
  const { workspaceId: wid, pipelines } = useSales();
  const refresh = useRefreshSales();
  const [pickedId, setPickedId] = useState<number | null>(null);
  const picked = pipelines.find((p) => p.id === pickedId) ?? pipelines[0];
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState("USD");
  const create = useMutation({
    mutationFn: () => salesApi.createPipeline(wid, newName.trim(), newCurrency.trim().toUpperCase() || "USD"),
    onSuccess: async (p) => {
      setNewName("");
      await refresh();
      setPickedId(p.id);
    },
  });
  return (
    <div>
      <section className="panel" aria-label="Pipelines">
        <h2>Pipelines</h2>
        <p className="muted small">A pipeline is the path a deal takes from first conversation to won or lost. Each stage carries the chance of winning a deal that sits in it, which is what weighs the forecast.</p>
        <div className="filters">
          {pipelines.length > 1 && (
            <label className="inline-select">
              <span className="visually-hidden">Pipeline</span>
              <select value={picked?.id} onChange={(e) => setPickedId(Number(e.target.value))}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
          )}
          <form className="row-inline" onSubmit={(e) => (e.preventDefault(), newName.trim() && create.mutate())}>
            <input placeholder="New pipeline name" aria-label="New pipeline name" maxLength={100} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className="narrow" aria-label="Currency" maxLength={3} value={newCurrency} onChange={(e) => setNewCurrency(e.target.value)} />
            <button type="submit" className="secondary" disabled={!newName.trim() || create.isPending}>Add pipeline</button>
          </form>
        </div>
        <ErrorLine error={create.error} />
        {picked && <PipelineEditor key={picked.id} pipeline={picked} onlyOne={pipelines.length === 1} />}
      </section>
    </div>
  );
}

function PipelineEditor({ pipeline, onlyOne }: { pipeline: SalesPipeline; onlyOne: boolean }) {
  const refresh = useRefreshSales();
  const [name, setName] = useState(pipeline.name);
  const [currency, setCurrency] = useState(pipeline.currency);
  const rename = useMutation({ mutationFn: () => salesApi.updatePipeline(pipeline.id, { name: name.trim(), currency: currency.trim().toUpperCase() }), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => salesApi.deletePipeline(pipeline.id), onSuccess: refresh });
  const order = useMutation({ mutationFn: (ids: number[]) => salesApi.orderStages(pipeline.id, ids), onSuccess: refresh });
  const [removing, setRemoving] = useState<SalesStage | null>(null);
  const [adding, setAdding] = useState({ name: "", probability: "30", kind: "open" as StageKind });
  const add = useMutation({
    mutationFn: () => salesApi.addStage(pipeline.id, { name: adding.name.trim(), kind: adding.kind, probability: Number(adding.probability) || 0 }),
    onSuccess: async () => (setAdding({ ...adding, name: "" }), refresh()),
  });
  const move = (i: number, dir: -1 | 1) => {
    const ids = pipeline.stages.map((s) => s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir]!, ids[i]!];
    order.mutate(ids);
  };

  return (
    <div>
      <form className="row-inline" style={{ margin: "12px 0" }} onSubmit={(e) => (e.preventDefault(), name.trim() && rename.mutate())}>
        <input aria-label="Pipeline name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="narrow" aria-label="Currency" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        <button type="submit" className="secondary" disabled={rename.isPending || (name.trim() === pipeline.name && currency.toUpperCase() === pipeline.currency)}>Save</button>
        <button type="button" className="ghost danger-text" disabled={onlyOne || del.isPending} title={onlyOne ? "Keep at least one pipeline" : undefined} onClick={() => confirm(`Delete the pipeline “${pipeline.name}”?`) && del.mutate()}><Trash2 size={14} /> Delete pipeline</button>
      </form>
      <ErrorLine error={rename.error ?? del.error ?? order.error} />

      <ul className="stage-list">
        {pipeline.stages.map((s, i) => (
          <StageRow key={`${s.id}:${s.name}:${s.probability}:${s.color}:${s.kind}`} stage={s} first={i === 0} last={i === pipeline.stages.length - 1} onMove={(d) => move(i, d)} onRemove={() => setRemoving(s)} />
        ))}
      </ul>

      <form className="row-inline stage-add" onSubmit={(e) => (e.preventDefault(), adding.name.trim() && add.mutate())}>
        <input placeholder="New stage, e.g. Demo" aria-label="New stage name" maxLength={60} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
        <select aria-label="What the stage means" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as StageKind })}>
          <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
        </select>
        {adding.kind === "open" && <input type="number" className="narrow" min={0} max={100} aria-label="Chance of winning, percent" value={adding.probability} onChange={(e) => setAdding({ ...adding, probability: e.target.value })} />}
        <button type="submit" className="secondary" disabled={!adding.name.trim() || add.isPending}>Add stage</button>
      </form>
      <ErrorLine error={add.error} />
      <p className="muted small">A pipeline needs at least one open, one won and one lost stage. New open stages go before Won and Lost.</p>
      {removing && <RemoveStageDialog stage={removing} pipeline={pipeline} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function StageRow({ stage, first, last, onMove, onRemove }: { stage: SalesStage; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  const refresh = useRefreshSales();
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [probability, setProbability] = useState(String(stage.probability));
  const [kind, setKind] = useState<StageKind>(stage.kind);
  const save = useMutation({
    mutationFn: () => salesApi.updateStage(stage.id, { name: name.trim(), color, kind, ...(kind === "open" ? { probability: Number(probability) || 0 } : {}) }),
    onSuccess: refresh,
  });
  const changed = name.trim() !== stage.name || color !== stage.color || kind !== stage.kind || (kind === "open" && Number(probability) !== stage.probability);
  return (
    <li>
      <input type="color" aria-label="Colour" value={color} onChange={(e) => setColor(e.target.value)} />
      <input aria-label="Stage name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="What the stage means" value={kind} onChange={(e) => setKind(e.target.value as StageKind)}>
        <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
      </select>
      {kind === "open" ? (
        <label className="chance" title="Chance that a deal in this stage is won">
          <input type="number" min={0} max={100} aria-label="Chance of winning, percent" value={probability} onChange={(e) => setProbability(e.target.value)} />%
        </label>
      ) : (
        <span className="chance muted small">{kind === "won" ? "100%" : "0%"}</span>
      )}
      <span className="row-actions">
        <button type="button" className="icon sm" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
        <button type="button" className="icon sm" aria-label="Move down" disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /></button>
        <button type="button" className="secondary" disabled={!changed || !name.trim() || save.isPending} onClick={() => save.mutate()}>Save</button>
        <button type="button" className="icon sm" aria-label={`Delete ${stage.name}`} onClick={onRemove}><Trash2 size={14} /></button>
      </span>
      {save.error && <span className="alert" role="alert">{save.error.message}</span>}
    </li>
  );
}

/** Deleting a stage: if deals sit in it, they need somewhere to go. */
function RemoveStageDialog({ stage, pipeline, onClose }: { stage: SalesStage; pipeline: SalesPipeline; onClose: () => void }) {
  const refresh = useRefreshSales();
  const others = pipeline.stages.filter((s) => s.id !== stage.id);
  const [target, setTarget] = useState<number | "">("");
  const [needsTarget, setNeedsTarget] = useState(false);
  const remove = useMutation({
    mutationFn: () => salesApi.deleteStage(stage.id, target === "" ? undefined : target),
    onError: (e) => e instanceof ApiError && e.status === 409 && /in this stage/.test(e.message) && setNeedsTarget(true),
    onSuccess: async () => (await refresh(), onClose()),
  });
  return (
    <Dialog title={`Delete “${stage.name}”`} onClose={onClose}>
      <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), remove.mutate())}>
        {needsTarget ? (
          <>
            <p>{remove.error?.message}</p>
            <label>Move them to<select required value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              <option value="" disabled>Choose a stage…</option>
              {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          </>
        ) : (
          <p>Remove this stage from the pipeline?</p>
        )}
        {!(needsTarget && remove.error?.message && /in this stage/.test(remove.error.message) && target === "") && <ErrorLine error={remove.error} />}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={remove.isPending || (needsTarget && target === "")}>Delete stage</button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- lead forms ----------
function FormsSection() {
  const { workspaceId: wid } = useSales();
  const forms = useQuery({ queryKey: ["sales", "forms", wid], queryFn: () => salesApi.forms(wid) });
  const refresh = useRefreshSales();
  const [name, setName] = useState("");
  const create = useMutation({ mutationFn: () => salesApi.createForm(wid, name.trim()), onSuccess: async () => (setName(""), refresh()) });
  return (
    <section className="panel" aria-label="Lead forms">
      <h2>Lead forms</h2>
      <p className="muted small">
        A lead form is a public page where anyone can introduce themselves, with no account needed. Each submission becomes an unassigned lead in the inbox, and the admins are notified.
        Anyone with a form's link can send leads, so only share it where you mean to; you can change a link at any time, which stops the old one working.
      </p>
      <ul className="form-list">
        {(forms.data ?? []).map((f) => <FormRow key={f.id} form={f} />)}
      </ul>
      {forms.data?.length === 0 && <p className="muted small">No forms yet.</p>}
      <form className="row-inline" onSubmit={(e) => (e.preventDefault(), name.trim() && create.mutate())}>
        <input placeholder="Name it after where you'll put it, e.g. Website" aria-label="New form name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={!name.trim() || create.isPending}>Create form</button>
      </form>
      <ErrorLine error={create.error ?? forms.error} />
    </section>
  );
}

function FormRow({ form }: { form: LeadForm }) {
  const refresh = useRefreshSales();
  const [copied, setCopied] = useState(false);
  const update = useMutation({ mutationFn: (b: { enabled?: boolean; rotate?: boolean }) => salesApi.updateForm(form.id, b), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => salesApi.deleteForm(form.id), onSuccess: refresh });
  const url = `${window.location.origin}/inquiry/${form.token}`;
  return (
    <li className={form.enabled ? "" : "off"}>
      <div className="grow">
        <strong>{form.name}</strong> {!form.enabled && <span className="muted small">(switched off)</span>}
        <span className="copy-row">
          <input readOnly aria-label={`Link for ${form.name}`} value={url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <div className="row-actions">
        <button type="button" className="secondary" disabled={update.isPending} onClick={() => update.mutate({ enabled: !form.enabled })}>{form.enabled ? "Switch off" : "Switch on"}</button>
        <button type="button" className="secondary" disabled={update.isPending} onClick={() => confirm("Change the link? The current one stops working immediately.") && update.mutate({ rotate: true })}><RefreshCw size={14} /> New link</button>
        <button type="button" className="icon sm" aria-label={`Delete ${form.name}`} onClick={() => confirm(`Delete the form “${form.name}”? Its link stops working.`) && del.mutate()}><Trash2 size={14} /></button>
      </div>
      <ErrorLine error={update.error ?? del.error} />
    </li>
  );
}

// ---------- old pipeline projects ----------
function LegacySection({ projects: current }: { projects: { id: number; name: string }[] }) {
  const { workspaceId: wid } = useSales();
  // A moved project stops being a pipeline and leaves the list, so keep the ones we started with to show how each went.
  const [projects] = useState(current);
  const refresh = useRefreshSales();
  const qc = useQueryClient();
  const [done, setDone] = useState<Record<number, { pipeline_id: number; deals: number; without_owner: number }>>({});
  const move = useMutation({
    mutationFn: (id: number) => salesApi.convertProject(id).then((r) => ({ id, r })),
    onSuccess: async ({ id, r }) => {
      setDone({ ...done, [id]: r });
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["projects"] })]);
    },
  });
  return (
    <section className="panel" aria-label="Old pipeline projects">
      <h2>Old pipeline projects</h2>
      <p className="muted small">
        Before Sales existed, deals were tasks in a “sales pipeline” project. Moving one here turns each of its tasks into a deal in a new pipeline with the same stages,
        keeps values, close dates and comments, and archives the project. Deals go to whoever the task was assigned to (or made by); give those people access under People and access.
      </p>
      <ul className="form-list">
        {projects.map((p) => (
          <li key={p.id}>
            <div className="grow"><strong>{p.name}</strong>{done[p.id] && (
              <div className="muted small" role="status">
                Moved {done[p.id]!.deals} deal{done[p.id]!.deals === 1 ? "" : "s"}{done[p.id]!.without_owner ? `, ${done[p.id]!.without_owner} without an owner (they are in the inbox)` : ""}.{" "}
                <Link to={`/sales/${wid}/pipeline?pipeline=${done[p.id]!.pipeline_id}`}>Open the pipeline</Link>
              </div>
            )}</div>
            <button type="button" disabled={move.isPending} onClick={() => confirm(`Move “${p.name}” into Sales? Its tasks become deals and the project is archived.`) && move.mutate(p.id)}>Move to Sales</button>
          </li>
        ))}
      </ul>
      <ErrorLine error={move.error} />
    </section>
  );
}
