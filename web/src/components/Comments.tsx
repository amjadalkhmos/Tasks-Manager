import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { api, type Comment, type Member, type Task } from "../api";
import { usePeople } from "../lib/people";
import { timeAgo } from "../lib/time";
import { Avatar } from "./Avatar";
import { CommentComposer } from "./CommentComposer";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The comment text with each mentioned person's "@Name" highlighted. */
function Body({ comment }: { comment: Comment }) {
  if (!comment.mentions.length) return <>{comment.body}</>;
  const re = new RegExp(`(${comment.mentions.map((m) => `@${escapeRe(m.name)}`).join("|")})`, "g");
  return (
    <>
      {comment.body.split(re).map((part, i) =>
        i % 2 ? <span className="mention" key={i}>{part}</span> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

export function Comments({ task, members, meId }: { task: Task; members: Member[]; meId: number }) {
  const qc = useQueryClient();
  const { nameOf } = usePeople();
  const comments = useQuery({ queryKey: ["comments", task.id], queryFn: () => api.comments(task.id) });
  const [editing, setEditing] = useState<number | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const canComment = task.access !== "read";

  const refresh = () =>
    Promise.all(["comments", "tasks", "task-activity", "alerts"].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  const add = useMutation({
    mutationFn: (v: { body: string; mentions: number[] }) => api.addComment(task.id, v.body, v.mentions),
    onSuccess: () => (setComposerKey((k) => k + 1), refresh()),
  });
  const edit = useMutation({
    mutationFn: (v: { id: number; body: string; mentions: number[] }) => api.editComment(v.id, v.body, v.mentions),
    onSuccess: () => (setEditing(null), refresh()),
  });
  const remove = useMutation({ mutationFn: api.deleteComment, onSuccess: refresh });

  return (
    <section className="panel-section" aria-label="Comments">
      <h3>Comments {task.comment_count > 0 && <span className="count">{task.comment_count}</span>}</h3>

      {comments.isLoading && <p className="muted small">Loading…</p>}
      {comments.data?.length === 0 && <p className="muted small">No comments yet.{canComment ? " Start the conversation below." : ""}</p>}

      <ul className="comments">
        {comments.data?.map((c) => (
          <li key={c.id} className="comment">
            <Avatar id={c.requester ? c.id * 7 : c.user_id} name={c.requester ?? nameOf(c.user_id)} size={26} />
            <div className="comment-main">
              <div className="comment-head">
                <strong>{c.requester ? <>{c.requester} <span className="muted small">(customer)</span></> : c.user_id === meId ? "You" : nameOf(c.user_id)}</strong>
                <span className="muted small" title={new Date(c.created_at).toLocaleString()}>
                  {timeAgo(c.created_at)}{c.edited_at ? " · edited" : ""}
                </span>
                <span className="comment-actions">
                  {c.user_id === meId && !c.requester && canComment && (
                    <button type="button" className="icon sm" aria-label="Edit comment" onClick={() => setEditing(c.id)}><Pencil size={13} /></button>
                  )}
                  {(c.user_id === meId || task.access === "admin") && (
                    <button
                      type="button"
                      className="icon sm"
                      aria-label="Delete comment"
                      onClick={() => confirm("Delete this comment?") && remove.mutate(c.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </span>
              </div>
              {editing === c.id ? (
                <CommentComposer
                  autoFocus
                  members={members}
                  meId={meId}
                  initial={c.body}
                  initialMentions={c.mentions}
                  submitLabel="Save"
                  busy={edit.isPending}
                  error={edit.error?.message}
                  onSubmit={(body, mentions) => edit.mutate({ id: c.id, body, mentions })}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <p className="comment-body"><Body comment={c} /></p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {remove.error && <p className="alert" role="alert">{remove.error.message}</p>}

      {canComment ? (
        <CommentComposer
          key={composerKey}
          members={members}
          meId={meId}
          busy={add.isPending}
          error={add.error?.message}
          onSubmit={(body, mentions) => add.mutate({ body, mentions })}
        />
      ) : (
        <p className="muted small">Viewers can read comments but not write them.</p>
      )}
    </section>
  );
}
