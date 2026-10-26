import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Trash2, Video, X } from "lucide-react";
import { api, type Meeting } from "../api";
import { fromLocalInput, nextHour, safeUrl, toLocalInput } from "../lib/datetime";
import { useTaskActions } from "../lib/useTaskActions";

interface Props {
  /** An existing meeting's id, or "new". */
  meetingId: number | "new";
  onClose: () => void;
  onOpenTask: (id: number) => void;
}

/** Create or edit a meeting, including which tasks it is linked to. */
export function MeetingDrawer({ meetingId, onClose, onOpenTask }: Props) {
  const actions = useTaskActions();
  const creating = meetingId === "new";
  const existing = useQuery({ queryKey: ["meeting", meetingId], queryFn: () => api.meetings().then((l) => l.find((m) => m.id === meetingId)), enabled: !creating });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });

  const [form, setForm] = useState<{ title: string; start: string; end: string; location: string; url: string; notes: string } | null>(null);
  const [scope, setScope] = useState<number | null>(null); // workspace id, or null for private (only chosen when creating)
  const [linkIds, setLinkIds] = useState<number[]>([]); // chosen while creating
  const [pick, setPick] = useState("");

  useEffect(() => {
    if (form) return;
    if (creating) {
      const s = nextHour();
      setForm({ title: "", start: toLocalInput(s.toISOString()), end: toLocalInput(new Date(s.getTime() + 30 * 60_000).toISOString()), location: "", url: "", notes: "" });
    } else if (existing.data) {
      const m = existing.data;
      setForm({ title: m.title, start: toLocalInput(m.starts_at), end: toLocalInput(m.ends_at), location: m.location, url: m.url, notes: m.notes });
    }
  }, [creating, existing.data, form]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meeting: Meeting | undefined = existing.data;
  const readOnly = !creating && meeting?.access === "read";
  const workspaceId = creating ? scope : (meeting?.workspace_id ?? null);
  const linked = creating ? linkIds : (meeting?.task_ids ?? []);
  const taskById = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  const candidates = (tasks.data ?? [])
    .filter((t) => t.workspace_id === workspaceId && !linked.includes(t.id) && t.access !== "read" && t.parent_id === null)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title));
  const writableWorkspaces = (workspaces.data ?? []).filter((w) => w.role !== "viewer");

  const startsAt = form ? fromLocalInput(form.start) : null;
  const endsAt = form ? fromLocalInput(form.end) : null;
  const badRange = !!startsAt && !!endsAt && Date.parse(endsAt) < Date.parse(startsAt);
  const badUrl = !!form && form.url.trim() !== "" && !safeUrl(form.url.trim());
  const valid = !!form && form.title.trim() !== "" && !!startsAt && !!endsAt && !badRange && !badUrl;

  const save = useMutation({
    mutationFn: async () => {
      const body = { title: form!.title.trim(), starts_at: startsAt!, ends_at: endsAt!, location: form!.location.trim(), url: form!.url.trim(), notes: form!.notes };
      return creating ? api.createMeeting({ ...body, workspace_id: scope, task_ids: linkIds }) : api.updateMeeting(meetingId, body);
    },
    onSuccess: () => actions.refresh().then(onClose),
  });
  const remove = useMutation({ mutationFn: () => api.deleteMeeting(meetingId as number), onSuccess: () => actions.refresh().then(onClose) });
  const link = useMutation({
    mutationFn: (taskId: number) => api.linkMeeting(meetingId as number, taskId),
    onSuccess: () => (setPick(""), actions.refresh()),
  });
  const unlink = useMutation({ mutationFn: (taskId: number) => api.unlinkMeeting(meetingId as number, taskId), onSuccess: actions.refresh });

  if (!form) return null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const joinUrl = safeUrl(form.url);
  const error = (save.error ?? remove.error ?? link.error ?? unlink.error)?.message;

  const addLink = (taskId: number) => (creating ? (setLinkIds([...linkIds, taskId]), setPick("")) : link.mutate(taskId));
  const removeLink = (taskId: number) => (creating ? setLinkIds(linkIds.filter((id) => id !== taskId)) : unlink.mutate(taskId));

  return (
    <div className="backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={creating ? "New meeting" : "Meeting details"}>
        <div className="drawer-head">
          <span className="muted small"><Video size={13} style={{ verticalAlign: "-2px" }} /> {creating ? "New meeting" : "Meeting"}</span>
          <button className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="drawer-body">
          {readOnly && <p className="blocked-note view-only">View only. You can read this meeting but not change it.</p>}
          {meeting?.source === "google" && (
            <p className="blocked-note view-only">
              Imported from Google Calendar.{" "}
              {safeUrl(meeting.external_url) && <a href={safeUrl(meeting.external_url)!} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}
            </p>
          )}

          <input className="title-input" aria-label="Meeting title" placeholder="Meeting title" readOnly={readOnly} value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} autoFocus={creating} />

          <fieldset className="bare" disabled={readOnly}>
            <div className="props">
              <div className="prop">
                <span className="k">Starts</span>
                <div className="v"><input type="datetime-local" aria-label="Starts" value={form.start} onChange={(e) => {
                  // keep the meeting's length when the start moves
                  const len = startsAt && endsAt ? Date.parse(endsAt) - Date.parse(startsAt) : 30 * 60_000;
                  const next = fromLocalInput(e.target.value);
                  set({ start: e.target.value, end: next ? toLocalInput(new Date(Date.parse(next) + Math.max(len, 0)).toISOString()) : form.end });
                }} /></div>
              </div>
              <div className="prop">
                <span className="k">Ends</span>
                <div className="v"><input type="datetime-local" aria-label="Ends" value={form.end} onChange={(e) => set({ end: e.target.value })} /></div>
              </div>
              <div className="prop">
                <span className="k">Location</span>
                <div className="v"><input aria-label="Location" placeholder="Room, address…" value={form.location} maxLength={200} onChange={(e) => set({ location: e.target.value })} /></div>
              </div>
              <div className="prop">
                <span className="k">Link</span>
                <div className="v">
                  <input aria-label="Video link" placeholder="https://…" inputMode="url" value={form.url} maxLength={2000} onChange={(e) => set({ url: e.target.value })} />
                  {joinUrl && <a href={joinUrl} target="_blank" rel="noopener noreferrer" className="small"><ExternalLink size={12} /> Open</a>}
                </div>
              </div>
              {creating && (
                <div className="prop">
                  <span className="k">Shared with</span>
                  <div className="v">
                    <select aria-label="Shared with" value={scope ?? ""} onChange={(e) => (setScope(e.target.value ? Number(e.target.value) : null), setLinkIds([]))}>
                      <option value="">Only me</option>
                      {writableWorkspaces.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
            {badRange && <p className="alert" role="alert">The meeting can't end before it starts.</p>}
            {badUrl && <p className="alert" role="alert">The link must start with http:// or https://</p>}
            <textarea className="notes-input" aria-label="Notes" placeholder="Agenda or notes…" rows={4} readOnly={readOnly} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </fieldset>

          <section className="panel-section">
            <h3>Linked tasks {linked.length > 0 && <span className="count">{linked.length}</span>}</h3>
            {linked.length === 0 && <p className="muted small">Not linked to any task yet.</p>}
            <ul className="tasks compact">
              {linked.map((id) => {
                const t = taskById.get(id);
                return (
                  <li key={id} className={t?.status === "done" ? "done" : ""}>
                    <button className="title" onClick={() => onOpenTask(id)} disabled={!t}>{t?.title ?? `Task #${id}`}</button>
                    {!readOnly && (
                      <button type="button" className="icon sm" aria-label={`Unlink ${t?.title ?? id}`} onClick={() => removeLink(id)}><X size={14} /></button>
                    )}
                  </li>
                );
              })}
            </ul>
            {!readOnly && (
              <div className="add-line">
                <select aria-label="Link a task" value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Link a task…</option>
                  {candidates.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
                <button type="button" className="secondary" disabled={!pick || link.isPending} onClick={() => addLink(Number(pick))}>Link</button>
              </div>
            )}
            <p className="muted small" style={{ marginTop: 6 }}>
              {workspaceId === null ? "Only your private tasks can be linked to a private meeting." : "Only tasks in this workspace can be linked."}
            </p>
          </section>

          {error && <p className="alert" role="alert" style={{ marginTop: 16 }}>{error}</p>}
        </div>

        <div className="drawer-foot">
          {!creating && meeting?.can_delete ? (
            <button className="ghost danger-text" onClick={() => confirm("Delete this meeting? Linked tasks are not affected.") && remove.mutate()}>
              <Trash2 size={15} /> Delete
            </button>
          ) : (
            <span />
          )}
          {readOnly ? (
            <button className="secondary" onClick={onClose}>Close</button>
          ) : (
            <button onClick={() => save.mutate()} disabled={!valid || save.isPending}>{creating ? "Create meeting" : "Save"}</button>
          )}
        </div>
      </aside>
    </div>
  );
}
