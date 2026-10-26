import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Mail, Pencil, Plus, Trash2, UserMinus, X } from "lucide-react";
import { api, type Member, type Role } from "../api";
import { Avatar } from "../components/Avatar";
import { describeActivity } from "../lib/activity";
import { usePeople } from "../lib/people";
import { timeAgo } from "../lib/time";

const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including deleting the workspace",
  admin: "Manage people and projects, delete anyone's tasks",
  member: "Create, edit and comment; delete their own tasks",
  viewer: "Read only",
};
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/** Roles the viewer of this page may give to `target` — mirrors the server's rules, which are the ones that count. */
function assignableRoles(myRole: Role, target: Member, meId: number): Role[] {
  if (target.id === meId) return [];
  if (myRole === "owner") return ["owner", "admin", "member", "viewer"];
  if (myRole === "admin" && (target.role === "member" || target.role === "viewer")) return ["member", "viewer"];
  return [];
}
function canRemove(myRole: Role, target: Member, meId: number): boolean {
  if (target.id === meId) return myRole !== "owner"; // the owner has to hand over first
  if (myRole === "owner") return true;
  return myRole === "admin" && (target.role === "member" || target.role === "viewer");
}

export function WorkspacePage({ onOpenTask }: { onOpenTask: (id: number) => void }) {
  const wsId = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { nameOf } = usePeople();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const detail = useQuery({ queryKey: ["workspace", wsId], queryFn: () => api.workspace(wsId) });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const feed = useInfiniteQuery({
    queryKey: ["workspace-activity", wsId],
    queryFn: ({ pageParam }) => api.workspaceActivity(wsId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [invited, setInvited] = useState<string | null>(null);
  const [newProject, setNewProject] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  const refreshAll = () =>
    Promise.all(["workspace", "workspaces", "workspace-activity", "people", "projects", "tasks", "alerts"].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const rename = useMutation({ mutationFn: (name: string) => api.renameWorkspace(wsId, name), onSuccess: () => (setRenaming(null), refreshAll()) });
  const invite = useMutation({
    mutationFn: () => api.invite(wsId, inviteEmail.trim(), inviteRole),
    onSuccess: (r) => (setInvited(r.email), setInviteEmail(""), refreshAll()),
  });
  const revoke = useMutation({ mutationFn: (id: number) => api.revokeInvite(wsId, id), onSuccess: refreshAll });
  const setRole = useMutation({ mutationFn: (v: { id: number; role: Role }) => api.setRole(wsId, v.id, v.role), onSuccess: refreshAll });
  const removeMember = useMutation({
    mutationFn: (v: { id: number; self: boolean }) => api.removeMember(wsId, v.id).then(() => v.self),
    onSuccess: async (self) => {
      await refreshAll();
      if (self) navigate("/");
    },
  });
  const addProject = useMutation({ mutationFn: (name: string) => api.createProject(name, wsId), onSuccess: () => (setNewProject(""), refreshAll()) });
  const delProject = useMutation({ mutationFn: api.deleteProject, onSuccess: refreshAll });
  const delWorkspace = useMutation({
    mutationFn: () => api.deleteWorkspace(wsId),
    onSuccess: async () => {
      await refreshAll();
      navigate("/");
    },
  });

  if (detail.isLoading) return <p className="muted">Loading…</p>;
  if (detail.error || !detail.data || !me) {
    return (
      <div className="empty">
        <h2>Workspace not found</h2>
        <p>It may have been deleted, or you may no longer be a member. <Link to="/">Back to your inbox</Link></p>
      </div>
    );
  }

  const ws = detail.data;
  const mine = ws.role;
  const isAdmin = mine === "owner" || mine === "admin";
  const wsProjects = (projects.data ?? []).filter((p) => p.workspace_id === wsId);
  const openIn = (projectId: number) => (tasks.data ?? []).filter((t) => t.project_id === projectId && t.status !== "done" && t.parent_id === null).length;
  const error = (rename.error ?? invite.error ?? revoke.error ?? setRole.error ?? removeMember.error ?? addProject.error ?? delProject.error ?? delWorkspace.error)?.message;

  return (
    <div>
      <header className="page-header">
        <div>
          {renaming === null ? (
            <h1>
              {ws.name}{" "}
              {isAdmin && (
                <button type="button" className="icon sm" aria-label="Rename workspace" onClick={() => setRenaming(ws.name)}><Pencil size={14} /></button>
              )}
            </h1>
          ) : (
            <form className="row-inline" onSubmit={(e) => (e.preventDefault(), renaming.trim() && rename.mutate(renaming.trim()))}>
              <input aria-label="Workspace name" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button type="submit" disabled={!renaming.trim() || rename.isPending}>Save</button>
              <button type="button" className="ghost" onClick={() => setRenaming(null)}>Cancel</button>
            </form>
          )}
          <p className="sub">You are {/^[aeiou]/.test(mine) ? "an" : "a"} {ROLE_LABEL[mine].toLowerCase()} · {ws.members.length} member{ws.members.length === 1 ? "" : "s"}</p>
        </div>
      </header>

      {error && <p className="alert" role="alert">{error}</p>}

      <section className="panel" aria-label="Members">
        <h2>Members</h2>
        <ul className="people-list">
          {ws.members.map((m) => {
            const options = assignableRoles(mine, m, me.id);
            const you = m.id === me.id;
            return (
              <li key={m.id}>
                <Avatar id={m.id} name={m.name} size={30} />
                <div className="who">
                  <strong>{m.name}{you ? " (you)" : ""}</strong>
                  <span className="muted small">{m.email}</span>
                </div>
                {options.length ? (
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(e) => {
                      const role = e.target.value as Role;
                      if (role !== "owner" || confirm(`Make ${m.name} the owner? You will become an admin.`)) setRole.mutate({ id: m.id, role });
                    }}
                  >
                    {options.map((r) => (
                      <option key={r} value={r}>{r === "owner" ? "Owner (transfer ownership)" : ROLE_LABEL[r]}</option>
                    ))}
                    {!options.includes(m.role) && <option value={m.role} disabled>{ROLE_LABEL[m.role]}</option>}
                  </select>
                ) : (
                  <span className="role-badge" title={ROLE_HELP[m.role]}>{ROLE_LABEL[m.role]}</span>
                )}
                {canRemove(mine, m, me.id) ? (
                  <button
                    type="button"
                    className="ghost danger-text"
                    onClick={() =>
                      confirm(you ? `Leave ${ws.name}? You'll lose access to everything in it.` : `Remove ${m.name} from ${ws.name}? Their assigned tasks become unassigned.`) &&
                      removeMember.mutate({ id: m.id, self: you })
                    }
                  >
                    {you ? <><LogOut size={14} /> Leave</> : <><UserMinus size={14} /> Remove</>}
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
        <details className="role-help">
          <summary>What can each role do?</summary>
          <dl>
            {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
              <div key={r}><dt>{ROLE_LABEL[r]}</dt><dd>{ROLE_HELP[r]}</dd></div>
            ))}
          </dl>
        </details>
      </section>

      {isAdmin && (
        <section className="panel" aria-label="Invitations">
          <h2>Invite people</h2>
          <p className="muted setting-help">
            Invite by email address. No email is sent: the person sees the invitation under Notifications the next time they sign in with that address
            (they can create an account first).
          </p>
          <form className="invite-form" onSubmit={(e) => (e.preventDefault(), inviteEmail.trim() && invite.mutate())}>
            <input type="email" required aria-label="Email address" placeholder="name@company.com" value={inviteEmail} onChange={(e) => (setInviteEmail(e.target.value), setInvited(null))} />
            <select aria-label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              {mine === "owner" && <option value="admin">Admin</option>}
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" disabled={invite.isPending}><Mail size={15} /> Invite</button>
          </form>
          {invited && <p className="result" role="status">Invited {invited}. They'll find it under Notifications.</p>}
          {ws.invites.length > 0 && (
            <>
              <h3 style={{ marginTop: 16 }}>Pending</h3>
              <ul className="people-list">
                {ws.invites.map((i) => (
                  <li key={i.id}>
                    <span className="avatar person ghost-avatar"><Mail size={14} /></span>
                    <div className="who">
                      <strong>{i.email}</strong>
                      <span className="muted small">{ROLE_LABEL[i.role]} · invited by {i.invited_by} {timeAgo(i.created_at.replace(" ", "T") + "Z")}</span>
                    </div>
                    <span />
                    <button type="button" className="icon sm" aria-label={`Cancel invitation for ${i.email}`} onClick={() => revoke.mutate(i.id)}><X size={14} /></button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="panel" aria-label="Projects">
        <h2>Projects</h2>
        {wsProjects.length === 0 && <p className="muted small">No projects yet. Create one to start sharing tasks.</p>}
        <ul className="people-list">
          {wsProjects.map((p) => (
            <li key={p.id}>
              <span className="dot" style={{ background: p.color }} />
              <div className="who">
                <Link to={`/project/${p.id}`}><strong>{p.name}</strong></Link>
                <span className="muted small">{openIn(p.id)} open</span>
              </div>
              <span />
              {isAdmin ? (
                <button
                  type="button"
                  className="icon sm"
                  aria-label={`Delete ${p.name}`}
                  onClick={() => {
                    const n = (tasks.data ?? []).filter((t) => t.project_id === p.id).length;
                    if (confirm(`Delete “${p.name}” and its ${n} task${n === 1 ? "" : "s"}? This can't be undone.`)) delProject.mutate(p.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              ) : <span />}
            </li>
          ))}
        </ul>
        {mine !== "viewer" && (
          <form className="invite-form" onSubmit={(e) => (e.preventDefault(), newProject.trim() && addProject.mutate(newProject.trim()))}>
            <input aria-label="New project name" placeholder="New project name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
            <button type="submit" className="secondary" disabled={!newProject.trim() || addProject.isPending}><Plus size={15} /> Add project</button>
          </form>
        )}
      </section>

      <section className="panel" aria-label="Activity">
        <h2>Activity</h2>
        {feed.data?.pages[0].items.length === 0 && <p className="muted small">Nothing has happened yet.</p>}
        <ul className="feed">
          {feed.data?.pages.flatMap((p) => p.items).map((a) => (
            <li key={a.id}>
              <Avatar id={a.user_id} name={nameOf(a.user_id)} size={22} />
              <span>
                <strong>{a.user_id === me.id ? "You" : nameOf(a.user_id)}</strong>{" "}
                {a.task_id !== null && a.kind !== "task_deleted" ? (
                  <button type="button" className="link" onClick={() => onOpenTask(a.task_id!)}>{describeActivity(a, nameOf)}</button>
                ) : (
                  describeActivity(a, nameOf)
                )}
              </span>
              <span className="muted small" title={new Date(a.created_at).toLocaleString()}>{timeAgo(a.created_at)}</span>
            </li>
          ))}
        </ul>
        {feed.hasNextPage && (
          <button type="button" className="secondary" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        )}
      </section>

      {mine === "owner" && (
        <section className="panel danger-zone" aria-label="Danger zone">
          <h2>Delete this workspace</h2>
          <p className="muted setting-help">
            This permanently deletes the workspace, its projects and every task in them for all {ws.members.length} member{ws.members.length === 1 ? "" : "s"}. Private tasks are not affected.
          </p>
          <form className="invite-form" onSubmit={(e) => (e.preventDefault(), confirmDelete === ws.name && delWorkspace.mutate())}>
            <input aria-label="Type the workspace name to confirm" placeholder={`Type “${ws.name}” to confirm`} value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} />
            <button type="submit" className="danger" disabled={confirmDelete !== ws.name || delWorkspace.isPending}>Delete workspace</button>
          </form>
        </section>
      )}
    </div>
  );
}
