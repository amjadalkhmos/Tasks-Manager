import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, BellOff, Check, MessageSquare, UserCheck, UserMinus, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { api, type Alert } from "../api";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { usePeople } from "../lib/people";
import { timeAgo } from "../lib/time";

const ICONS: Record<Alert["kind"], ReactNode> = {
  assigned: <UserCheck size={15} />,
  mentioned: <AtSign size={15} />,
  commented: <MessageSquare size={15} />,
  invite_accepted: <UserPlus size={15} />,
  removed: <UserMinus size={15} />,
};

function sentence(a: Alert, actor: string): ReactNode {
  const t = <strong>“{a.title}”</strong>;
  switch (a.kind) {
    case "assigned": return <>{actor} assigned you {t}</>;
    case "mentioned": return <>{actor} mentioned you on {t}</>;
    case "commented": return <>{actor} commented on {t}</>;
    case "invite_accepted": return <>{actor} joined <strong>{a.title}</strong></>;
    case "removed": return <>You were removed from <strong>{a.title}</strong></>;
  }
}

export function NotificationsPage({ onOpenTask }: { onOpenTask: (id: number) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { nameOf } = usePeople();
  const alerts = useQuery({ queryKey: ["alerts"], queryFn: api.alerts });
  const invites = useQuery({ queryKey: ["my-invites"], queryFn: api.myInvites });

  const refresh = () => Promise.all(["alerts", "my-invites", "workspaces", "projects", "tasks", "people"].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const markRead = useMutation({ mutationFn: (ids?: number[]) => api.markAlertsRead(ids), onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) });
  const accept = useMutation({
    mutationFn: api.acceptInvite,
    onSuccess: async (r) => {
      await refresh();
      navigate(`/workspace/${r.workspace_id}`);
    },
  });
  const decline = useMutation({ mutationFn: api.declineInvite, onSuccess: refresh });

  const items = alerts.data?.items ?? [];
  const pending = invites.data ?? [];
  const nothing = !alerts.isLoading && !invites.isLoading && items.length === 0 && pending.length === 0;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Notifications</h1>
          <p className="sub">{alerts.data ? (alerts.data.unread ? `${alerts.data.unread} unread` : "All caught up") : " "}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="secondary" disabled={!alerts.data?.unread || markRead.isPending} onClick={() => markRead.mutate(undefined)}>
            <Check size={15} /> Mark all read
          </button>
        </div>
      </header>

      {(accept.error ?? decline.error) && <p className="alert" role="alert">{(accept.error ?? decline.error)!.message}</p>}

      {pending.length > 0 && (
        <section className="panel" aria-label="Invitations">
          <h2>Invitations</h2>
          <ul className="people-list">
            {pending.map((i) => (
              <li key={i.id}>
                <span className="avatar person ghost-avatar"><UserPlus size={14} /></span>
                <div className="who">
                  <strong>{i.workspace_name}</strong>
                  <span className="muted small">{i.invited_by} invited you as {i.role} · {timeAgo(i.created_at.replace(" ", "T") + "Z")}</span>
                </div>
                <button type="button" disabled={accept.isPending} onClick={() => accept.mutate(i.id)}>Accept</button>
                <button type="button" className="secondary" disabled={decline.isPending} onClick={() => decline.mutate(i.id)}>Decline</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {nothing && (
        <EmptyState icon={<BellOff size={20} />} title="Nothing yet">
          You'll be notified here when someone assigns you a task, mentions you, comments on your work, or invites you to a workspace.
        </EmptyState>
      )}

      <ul className="alert-list">
        {items.map((a) => {
          const actor = a.actor_id ? nameOf(a.actor_id) : "Someone";
          const open = () => {
            if (!a.read) markRead.mutate([a.id]);
            if (a.task_id !== null && a.kind !== "removed") onOpenTask(a.task_id);
            else if (a.workspace_id !== null && a.kind === "invite_accepted") navigate(`/workspace/${a.workspace_id}`);
          };
          return (
            <li key={a.id} className={a.read ? "" : "unread"}>
              <button type="button" className="alert-row" onClick={open}>
                {a.actor_id ? <Avatar id={a.actor_id} name={actor} size={28} /> : <span className="avatar person ghost-avatar">{ICONS[a.kind]}</span>}
                <span className="alert-text">
                  <span>{sentence(a, actor)}</span>
                  <span className="muted small">{ICONS[a.kind]} {timeAgo(a.created_at)}</span>
                </span>
                {!a.read && <span className="unread-dot" aria-label="Unread" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
