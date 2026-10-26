import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Link2, MapPin, Plus, Video } from "lucide-react";
import { api, type Meeting } from "../api";
import { EmptyState } from "../components/EmptyState";
import { MeetingDrawer } from "../components/MeetingDrawer";
import { formatRange, safeUrl } from "../lib/datetime";

export function MeetingsPage({ onOpenTask }: { onOpenTask: (id: number) => void }) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const meetings = useQuery({ queryKey: ["meetings"], queryFn: () => api.meetings() });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const wsName = (id: number | null) => (id === null ? "Private" : (workspaces.data?.find((w) => w.id === id)?.name ?? "Workspace"));

  const now = Date.now();
  const all = [...(meetings.data ?? [])];
  const upcoming = all.filter((m) => Date.parse(m.ends_at) >= now).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const past = all.filter((m) => Date.parse(m.ends_at) < now).sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));

  const row = (m: Meeting) => {
    const joinUrl = safeUrl(m.url);
    return (
      <li key={m.id} className="meeting-row">
        <button className="title" onClick={() => setEditing(m.id)}>
          <strong>{m.title}</strong>
          <span className="muted small">{formatRange(m.starts_at, m.ends_at)} · {wsName(m.workspace_id)}</span>
        </button>
        <span className="meta">
          {m.location && <span title="Location"><MapPin size={13} />{m.location}</span>}
          {m.task_ids.length > 0 && <span title="Linked tasks"><Link2 size={13} />{m.task_ids.length}</span>}
          {joinUrl && <a href={joinUrl} target="_blank" rel="noopener noreferrer" aria-label={`Join ${m.title}`}><ExternalLink size={13} />Join</a>}
        </span>
      </li>
    );
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Meetings</h1>
          <p className="sub">Meetings you've scheduled, and the tasks each one is linked to.</p>
        </div>
        <button onClick={() => setEditing("new")}><Plus size={16} /> New meeting</button>
      </header>
      {meetings.error && <p className="alert" role="alert">{meetings.error.message}</p>}

      {meetings.data && all.length === 0 && (
        <EmptyState icon={<Video size={28} />} title="No meetings yet">Schedule a meeting here, or from any task, and link it to the work it's about.</EmptyState>
      )}
      {upcoming.length > 0 && (
        <section>
          <h2 className="group-label">Upcoming <span className="count">{upcoming.length}</span></h2>
          <ul className="tasks">{upcoming.map(row)}</ul>
        </section>
      )}
      {past.length > 0 && (
        <section>
          <h2 className="group-label">Past <span className="count">{past.length}</span></h2>
          <ul className="tasks">{past.map(row)}</ul>
        </section>
      )}

      {editing !== null && <MeetingDrawer key={String(editing)} meetingId={editing} onClose={() => setEditing(null)} onOpenTask={onOpenTask} />}
    </div>
  );
}
