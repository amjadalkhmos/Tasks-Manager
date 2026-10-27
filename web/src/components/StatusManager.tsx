import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { api, type Category, type Status, type StatusScope } from "../api";
import { BUILTIN } from "../lib/statuses";

const CATEGORY_LABEL: Record<Category, string> = { todo: "Not started", doing: "In progress", done: "Finished" };

function Row({ s, first, last, canManage, showProbability, onMove, onChanged, onError }: {
  s: Status; first: boolean; last: boolean; canManage: boolean; showProbability: boolean;
  onMove: (dir: -1 | 1) => void; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [name, setName] = useState(s.name);
  useEffect(() => setName(s.name), [s.name]);
  const [chance, setChance] = useState(s.probability === null ? "" : String(s.probability));
  useEffect(() => setChance(s.probability === null ? "" : String(s.probability)), [s.probability]);
  const update = useMutation({
    mutationFn: (p: Partial<Pick<Status, "name" | "color" | "probability">>) => api.updateStatus(s.id, p),
    onSuccess: () => (onError(null), onChanged()),
    onError: (e) => (onError(e.message), setName(s.name)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteStatus(s.id),
    onSuccess: () => (onError(null), onChanged()),
    onError: (e) => onError(e.message),
  });
  return (
    <li className="status-row">
      <input type="color" aria-label={`Colour of ${s.name}`} disabled={!canManage} value={s.color} onChange={(e) => update.mutate({ color: e.target.value })} />
      <input
        aria-label={`Name of ${s.name}`}
        disabled={!canManage}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== s.name && update.mutate({ name: name.trim() })}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())}
      />
      <span className="muted small status-cat">{CATEGORY_LABEL[s.category]}</span>
      {showProbability && (
        <label className="chance" title="Chance that a deal in this stage is won. Used to weigh the pipeline forecast.">
          <input
            type="number" min={0} max={100} aria-label={`Win chance of ${s.name}`} disabled={!canManage} value={chance} placeholder="–"
            onChange={(e) => setChance(e.target.value)}
            onBlur={() => {
              const next = chance === "" ? null : Math.min(100, Math.max(0, Math.round(Number(chance))));
              if (next !== s.probability) update.mutate({ probability: next });
            }}
          />%
        </label>
      )}
      {canManage && (
        <span className="status-actions">
          <button type="button" className="icon sm" aria-label={`Move ${s.name} up`} disabled={first} onClick={() => onMove(-1)}><ArrowUp size={14} /></button>
          <button type="button" className="icon sm" aria-label={`Move ${s.name} down`} disabled={last} onClick={() => onMove(1)}><ArrowDown size={14} /></button>
          <button
            type="button"
            className="icon sm"
            aria-label={`Delete ${s.name}`}
            disabled={remove.isPending}
            onClick={() => confirm(`Delete the status "${s.name}"? Tasks with it move to another ${CATEGORY_LABEL[s.category].toLowerCase()} status.`) && remove.mutate()}
          >
            <Trash2 size={14} />
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * Defines the statuses for a project or a workspace. With none defined, everything uses the built-in To do / Doing / Done;
 * customising starts from those three and lets the team rename, recolour, reorder, add and remove.
 */
export function StatusManager({ scope, canManage, inheritedFrom, showProbability = false }: { scope: StatusScope; canManage: boolean; inheritedFrom?: string; showProbability?: boolean }) {
  const qc = useQueryClient();
  const all = useQuery({ queryKey: ["statuses"], queryFn: api.statuses });
  const own = (all.data ?? [])
    .filter((s) => ("project_id" in scope ? s.project_id === scope.project_id : s.workspace_id === scope.workspace_id))
    .sort((a, b) => a.position - b.position || a.id - b.id);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("doing");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => Promise.all(["statuses", "tasks", "overview"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const settle = { onSuccess: () => (setError(null), refresh()), onError: (e: Error) => setError(e.message) };
  const seed = useMutation({ mutationFn: () => api.seedStatuses(scope), ...settle });
  const add = useMutation({ mutationFn: () => api.addStatus(scope, { name: name.trim(), category }), ...settle, onSuccess: () => (setName(""), setError(null), refresh()) });
  const reset = useMutation({ mutationFn: () => api.resetStatuses(scope), ...settle });
  const reorder = useMutation({
    mutationFn: async ({ a, b }: { a: Status; b: Status }) => {
      // swap the two positions; when they tie (never expected), nudge one
      const pa = a.position === b.position ? b.position + 1 : b.position;
      await Promise.all([api.updateStatus(a.id, { position: pa }), api.updateStatus(b.id, { position: a.position })]);
    },
    ...settle,
  });

  const what = "project_id" in scope ? "project" : "workspace";
  return (
    <div className="status-manager">
      {own.length === 0 ? (
        <>
          <p className="muted small">
            {inheritedFrom
              ? `This ${what} uses the statuses of ${inheritedFrom}, or the built-in ones if it has none.`
              : `This ${what} uses the built-in statuses.`}{" "}
            Every task shows one of them.
          </p>
          <ul className="status-list">
            {BUILTIN.map((s) => (
              <li className="status-row" key={s.category}>
                <span className="swatch" style={{ background: s.color }} />
                <span>{s.name}</span>
                <span className="muted small status-cat">{CATEGORY_LABEL[s.category]}</span>
              </li>
            ))}
          </ul>
          {canManage ? (
            <button type="button" className="secondary" disabled={seed.isPending} onClick={() => seed.mutate()}>
              Customise statuses for this {what}
            </button>
          ) : (
            <p className="muted small">Only {what === "project" ? "the project's managers" : "workspace admins"} can change these.</p>
          )}
        </>
      ) : (
        <>
          <ul className="status-list">
            {own.map((s, i) => (
              <Row
                key={s.id}
                s={s}
                first={i === 0}
                last={i === own.length - 1}
                canManage={canManage}
                showProbability={showProbability}
                onMove={(dir) => reorder.mutate({ a: s, b: own[i + dir] })}
                onChanged={refresh}
                onError={setError}
              />
            ))}
          </ul>
          {showProbability && <p className="muted small">The percentage is the chance a deal in that stage is won; it weighs the forecast. A finished stage at 0% counts as lost.</p>}
          <p className="muted small">The grey label is the stage a status belongs to. It decides what counts as finished, and it can't be changed once a status exists.</p>
          {canManage && (
            <>
              <form
                className="add-line"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim()) add.mutate();
                }}
              >
                <input aria-label="New status name" placeholder="New status, e.g. In review" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
                <select aria-label="New status stage" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
                  {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                    <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                  ))}
                </select>
                <button type="submit" className="secondary" disabled={!name.trim() || add.isPending}><Plus size={15} /> Add</button>
              </form>
              <button
                type="button"
                className="ghost"
                disabled={reset.isPending}
                onClick={() => confirm(`Go back to the built-in statuses? Tasks keep their stage (to do, doing or done).`) && reset.mutate()}
              >
                <RotateCcw size={14} /> Back to built-in statuses
              </button>
            </>
          )}
        </>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
    </div>
  );
}
