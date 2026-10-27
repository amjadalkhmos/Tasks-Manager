import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, CalendarCheck, Mail, NotebookPen, Phone, Trash2 } from "lucide-react";
import { api, salesApi, type FollowUp, type SalesActivity } from "../../api";
import { useRefreshSales, useSales } from "../../lib/sales";
import { timeAgo } from "../../lib/time";
import { ErrorLine } from "./bits";

type Target = { lead_id: number } | { deal_id: number } | { account_id: number } | { contact_id: number };
type Logged = "call" | "email" | "meeting" | "note";

const KINDS: { kind: Logged; label: string; icon: ReactNode }[] = [
  { kind: "call", label: "Call", icon: <Phone size={14} /> },
  { kind: "email", label: "Email", icon: <Mail size={14} /> },
  { kind: "meeting", label: "Meeting", icon: <CalendarCheck size={14} /> },
  { kind: "note", label: "Note", icon: <NotebookPen size={14} /> },
];
const ICON: Record<SalesActivity["kind"], ReactNode> = {
  call: <Phone size={14} />, email: <Mail size={14} />, meeting: <CalendarCheck size={14} />, note: <NotebookPen size={14} />, system: <Bot size={14} />,
};

/** Calls, emails, meetings and notes against a record, newest first, with a short form to add one. */
export function ActivityPanel({ target, activities, canEdit, showWhere }: { target: Target; activities: SalesActivity[]; canEdit: boolean; showWhere?: boolean }) {
  const { me } = useSales();
  const refresh = useRefreshSales();
  const [kind, setKind] = useState<Logged>("call");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [minutes, setMinutes] = useState("");

  const log = useMutation({
    mutationFn: () => salesApi.logActivity({ ...target, kind, subject: subject.trim(), body: body.trim(), ...(kind !== "note" && minutes ? { duration_min: Number(minutes) } : {}) }),
    onSuccess: async () => {
      setSubject("");
      setBody("");
      setMinutes("");
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: salesApi.deleteActivity, onSuccess: refresh });

  return (
    <section className="panel-section" aria-label="Activity">
      <h3>Activity <span className="count">{activities.filter((a) => a.kind !== "system").length}</span></h3>
      {canEdit && (
        <form
          className="log-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (subject.trim() || body.trim()) log.mutate();
          }}
        >
          <div className="segmented" role="radiogroup" aria-label="What happened">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? "on" : ""} onClick={() => setKind(k.kind)}>{k.icon} {k.label}</button>
            ))}
          </div>
          <input placeholder={kind === "note" ? "Title (optional)" : "What was it about?"} aria-label="Subject" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea rows={2} placeholder="Details" aria-label="Details" maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="row-inline">
            {kind !== "note" && <input type="number" min={0} max={1440} className="narrow" placeholder="Minutes" aria-label="Minutes" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
            <button type="submit" disabled={log.isPending || !(subject.trim() || body.trim())}>Log {kind}</button>
          </div>
          <ErrorLine error={log.error} />
        </form>
      )}
      {activities.length === 0 && <p className="muted small">Nothing logged yet.</p>}
      <ul className="activity-list">
        {activities.map((a) => (
          <li key={a.id} className={a.kind === "system" ? "system" : ""}>
            <span className="ico" aria-hidden="true">{ICON[a.kind]}</span>
            <div className="what">
              {a.subject && <strong>{a.subject}</strong>}
              {a.body && <span className="body">{a.body}</span>}
              <span className="muted small">
                {a.kind === "system" ? "" : `${a.user_name ?? "Someone"} · `}{timeAgo(a.occurred_at)}
                {a.duration_min ? ` · ${a.duration_min} min` : ""}
                {showWhere && a.deal_title ? ` · ${a.deal_title}` : ""}
              </span>
            </div>
            {a.kind !== "system" && canEdit && (a.user_id === me.user_id || me.manager) && (
              <button type="button" className="icon sm" aria-label="Remove this entry" disabled={remove.isPending} onClick={() => confirm("Remove this entry?") && remove.mutate(a.id)}><Trash2 size={14} /></button>
            )}
          </li>
        ))}
      </ul>
      <ErrorLine error={remove.error} />
    </section>
  );
}

/** Tasks about this record, planned by the person looking at it. */
export function FollowUpsPanel({ target, followups }: { target: { lead_id: number } | { deal_id: number } | { account_id: number }; followups: FollowUp[] }) {
  const refresh = useRefreshSales();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const add = useMutation({
    mutationFn: () => salesApi.addFollowUp({ ...target, title: title.trim(), ...(due ? { due_at: new Date(`${due}T09:00:00`).toISOString() } : {}) }),
    onSuccess: async () => {
      setTitle("");
      setDue("");
      await refresh();
    },
  });
  const complete = useMutation({ mutationFn: (id: number) => api.completeTask(id), onSuccess: refresh });
  const open = followups.filter((f) => f.status !== "done");
  const late = (f: FollowUp) => !!f.due_at && Date.parse(f.due_at) < Date.now();

  return (
    <section className="panel-section" aria-label="Follow-ups">
      <h3>Follow-ups <span className="count">{open.length}</span></h3>
      <ul className="followups">
        {followups.map((f) => (
          <li key={f.id} className={f.status === "done" ? "done" : ""}>
            <input type="checkbox" checked={f.status === "done"} disabled={f.status === "done" || complete.isPending} aria-label={`Complete ${f.title}`} onChange={() => complete.mutate(f.id)} />
            <span className="t">{f.title}</span>
            {f.due_at && <span className={`muted small${late(f) && f.status !== "done" ? " late" : ""}`}>{new Date(f.due_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
          </li>
        ))}
      </ul>
      <form
        className="row-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) add.mutate();
        }}
      >
        <input className="grow" placeholder="Add a follow-up, e.g. Send the proposal" aria-label="New follow-up" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button type="submit" disabled={add.isPending || !title.trim()}>Add</button>
      </form>
      <p className="muted small">Follow-ups are your own tasks, so they also show in your task lists.</p>
      <ErrorLine error={add.error ?? complete.error} />
    </section>
  );
}
