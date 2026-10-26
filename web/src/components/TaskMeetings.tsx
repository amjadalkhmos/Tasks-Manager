import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarPlus, ExternalLink, MapPin, Pencil, Video, X } from "lucide-react";
import { api, type Task } from "../api";
import { formatRange, fromLocalInput, nextHour, safeUrl, toLocalInput } from "../lib/datetime";
import { useTaskActions } from "../lib/useTaskActions";

const LENGTHS = [15, 30, 45, 60, 90, 120];

/**
 * The "Meetings" section of a task: the meetings linked to it, a way to link one that already exists, and a short form
 * to schedule a new one and link it in the same step. Full editing happens on the Meetings page.
 */
export function TaskMeetings({ task, readOnly, onEdit }: { task: Task; readOnly: boolean; onEdit: (meetingId: number) => void }) {
  const actions = useTaskActions();
  const linked = useQuery({ queryKey: ["task-meetings", task.id], queryFn: () => api.taskMeetings(task.id) });
  const all = useQuery({ queryKey: ["meetings"], queryFn: () => api.meetings(), enabled: !readOnly });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState(() => toLocalInput(nextHour().toISOString()));
  const [length, setLength] = useState(30);
  const [location, setLocation] = useState("");
  const [url, setUrl] = useState("");
  const [pick, setPick] = useState("");

  const create = useMutation({
    mutationFn: () => {
      const startsAt = fromLocalInput(start)!;
      return api.createMeeting({
        title: title.trim(),
        starts_at: startsAt,
        ends_at: new Date(Date.parse(startsAt) + length * 60_000).toISOString(),
        location: location.trim(),
        url: url.trim(),
        workspace_id: task.workspace_id,
        task_ids: [task.id],
      });
    },
    onSuccess: () => {
      setTitle("");
      setLocation("");
      setUrl("");
      setAdding(false);
      return actions.refresh();
    },
  });
  const link = useMutation({ mutationFn: (id: number) => api.linkMeeting(id, task.id), onSuccess: () => (setPick(""), actions.refresh()) });
  const unlink = useMutation({ mutationFn: (id: number) => api.unlinkMeeting(id, task.id), onSuccess: actions.refresh });

  const meetings = linked.data ?? [];
  const linkedIds = new Set(meetings.map((m) => m.id));
  // Only meetings in the same place (the same workspace, or private) can be linked to this task.
  const candidates = (all.data ?? [])
    .filter((m) => m.workspace_id === task.workspace_id && !linkedIds.has(m.id) && m.access !== "read" && m.source === "local")
    .sort((a, b) => Math.abs(Date.parse(a.starts_at) - Date.now()) - Math.abs(Date.parse(b.starts_at) - Date.now()));
  const error = (create.error ?? link.error ?? unlink.error)?.message;

  return (
    <section className="panel-section" aria-label="Meetings">
      <h3>
        <Video size={14} /> Meetings {meetings.length > 0 && <span className="count">{meetings.length}</span>}
        {!readOnly && !adding && (
          <button type="button" className="ghost suggest-btn" onClick={() => setAdding(true)}>
            <CalendarPlus size={14} /> Schedule
          </button>
        )}
      </h3>

      {linked.isLoading && <p className="muted small">Loading…</p>}
      {!linked.isLoading && meetings.length === 0 && !adding && (
        <p className="muted small">No meetings linked.{readOnly ? "" : " Schedule one, or link a meeting that already exists."}</p>
      )}

      <ul className="meeting-list">
        {meetings.map((m) => {
          const joinUrl = safeUrl(m.url);
          return (
            <li key={m.id}>
              <div className="meeting-main">
                <strong>{m.title}</strong>
                <span className="muted small">{formatRange(m.starts_at, m.ends_at)}</span>
                {(m.location || joinUrl) && (
                  <span className="meeting-where small">
                    {m.location && <span><MapPin size={12} /> {m.location}</span>}
                    {joinUrl && (
                      <a href={joinUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} /> Join link</a>
                    )}
                  </span>
                )}
              </div>
              <button type="button" className="icon sm" aria-label={`Edit ${m.title}`} onClick={() => onEdit(m.id)}><Pencil size={13} /></button>
              {!readOnly && (
                <button type="button" className="icon sm" aria-label={`Unlink ${m.title}`} disabled={unlink.isPending} onClick={() => unlink.mutate(m.id)}>
                  <X size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!readOnly && candidates.length > 0 && (
        <div className="add-line">
          <select aria-label="Link an existing meeting" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Link an existing meeting…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>{m.title} — {formatRange(m.starts_at, m.ends_at)}</option>
            ))}
          </select>
          <button type="button" className="secondary" disabled={!pick || link.isPending} onClick={() => link.mutate(Number(pick))}>Link</button>
        </div>
      )}

      {adding && (
        <form
          className="meeting-form"
          aria-label="Schedule a meeting"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && start) create.mutate();
          }}
        >
          <input autoFocus placeholder="Meeting title" aria-label="Meeting title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <div className="row">
            <input type="datetime-local" aria-label="Meeting start" value={start} onChange={(e) => setStart(e.target.value)} />
            <select aria-label="Meeting length" value={length} onChange={(e) => setLength(Number(e.target.value))}>
              {LENGTHS.map((n) => (
                <option key={n} value={n}>{n < 60 ? `${n} min` : n % 60 ? `${n / 60}h ${n % 60}m` : `${n / 60} hour${n === 60 ? "" : "s"}`}</option>
              ))}
            </select>
          </div>
          <input placeholder="Location (optional)" aria-label="Meeting location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
          <input placeholder="Video link (optional), e.g. https://…" aria-label="Meeting link" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} inputMode="url" />
          <div className="row-inline">
            <button type="submit" disabled={!title.trim() || !start || create.isPending}>{create.isPending ? "Scheduling…" : "Schedule and link"}</button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
    </section>
  );
}
