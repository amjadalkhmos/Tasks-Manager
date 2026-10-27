import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api, type ProjectType } from "../api";
import { PROJECT_TYPES, TYPE_INFO } from "../lib/projectTypes";

/**
 * Starting a project: what kind it is (which sets its statuses and its default view), where it lives, and the few
 * things worth deciding on day one. Everything can be changed later from the project's Settings.
 */
export function NewProjectDialog({ workspaceId, onClose }: { workspaceId?: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const [type, setType] = useState<ProjectType>("delivery");
  const [name, setName] = useState("");
  const [ws, setWs] = useState<string>(workspaceId ? String(workspaceId) : "");
  const [leadId, setLeadId] = useState("");
  const [start, setStart] = useState("");
  const [target, setTarget] = useState("");
  const [description, setDescription] = useState("");

  const wsId = ws === "" ? null : Number(ws);
  const detail = useQuery({ queryKey: ["workspace", wsId], queryFn: () => api.workspace(wsId!), enabled: wsId !== null });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const leads = wsId === null ? (me ? [{ id: me.id, name: `${me.name} (you)` }] : []) : (detail.data?.members ?? []).filter((m) => m.role !== "viewer");
  useEffect(() => setLeadId(""), [ws]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const badDates = !!start && !!target && target < start;
  const create = useMutation({
    mutationFn: () =>
      api.createProject(name.trim(), wsId ?? undefined, {
        type,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(leadId ? { lead_id: Number(leadId) } : {}),
        ...(start ? { start_date: start } : {}),
        ...(target ? { target_date: target } : {}),
      }),
    onSuccess: async (p) => {
      // The new project's statuses must be in the cache before its page opens, or its board would briefly show the defaults.
      await Promise.all([
        qc.refetchQueries({ queryKey: ["statuses"], type: "all" }),
        qc.refetchQueries({ queryKey: ["projects"], type: "all" }),
        qc.invalidateQueries({ queryKey: ["portfolio"] }),
      ]);
      onClose();
      navigate(`/project/${p.id}`);
    },
  });
  const writable = (workspaces.data ?? []).filter((w) => w.role !== "viewer");

  return (
    <div className="backdrop top" onClick={onClose}>
      <form
        className="dialog"
        role="dialog"
        aria-label="New project"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !badDates) create.mutate();
        }}
      >
        <div className="dialog-head">
          <h2>New project</h2>
          <button type="button" className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="type-grid" role="radiogroup" aria-label="Project type">
          {PROJECT_TYPES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} className={`type-card${type === t ? " on" : ""}`} onClick={() => setType(t)}>
              <strong>{TYPE_INFO[t].label}</strong>
              <span>{TYPE_INFO[t].blurb}</span>
            </button>
          ))}
        </div>
        <p className="muted small">Starts with: {TYPE_INFO[type].starts}.</p>

        <div className="settings-form">
          <label>
            Name
            <input autoFocus aria-label="Project name" value={name} maxLength={100} placeholder="e.g. Website relaunch" onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="two">
            <label>
              Where
              <select aria-label="Where" value={ws} disabled={!!workspaceId} onChange={(e) => setWs(e.target.value)}>
                <option value="">Private (only me)</option>
                {writable.map((w) => (
                  <option key={w.id} value={w.id}>{w.name} (shared)</option>
                ))}
              </select>
            </label>
            <label>
              Project lead
              <select aria-label="Project lead" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
                <option value="">No lead yet</option>
                {leads.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          </div>
          {type !== "initiative" && type !== "support" && (
            <div className="two">
              <label>Start date<input type="date" aria-label="Start date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label>Target date<input type="date" aria-label="Target date" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
            </div>
          )}
          {badDates && <p className="alert" role="alert">The target date can't be before the start date.</p>}
          <label>
            What is it for? <span className="muted small">(optional)</span>
            <textarea rows={2} aria-label="Description" value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        {create.error && <p className="alert" role="alert">{create.error.message}</p>}
        <div className="row-inline" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!name.trim() || badDates || create.isPending}>{create.isPending ? "Creating…" : "Create project"}</button>
        </div>
      </form>
    </div>
  );
}
