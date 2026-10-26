import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, ListTree, Lock } from "lucide-react";
import { api, type Task } from "../api";
import { PRIORITY, dueState, formatDue, positionBetween } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

type Status = Task["status"];
const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "doing", label: "Doing" },
  { status: "done", label: "Done" },
];
const DONE_LIMIT = 20;

export function BoardPage({ onOpen }: { onOpen: (id: number) => void }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const actions = useTaskActions();
  const [project, setProject] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);

  const all = (tasks.data ?? []).filter(
    (t) => t.parent_id === null && (project === "" || t.project_id === Number(project)),
  );
  const column = (status: Status) => {
    const items = all.filter((t) => t.status === status);
    return status === "done"
      ? items.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")).slice(0, DONE_LIMIT)
      : items.sort((a, b) => a.position - b.position || a.id - b.id);
  };

  /** Move a card into `status`, placed before `before` (or at the end when omitted). */
  const move = (id: number, status: Status, before?: Task) => {
    const task = all.find((t) => t.id === id);
    if (!task || before?.id === id) return;
    if (status === "done") {
      if (task.status !== "done") actions.complete.mutate(id);
      return;
    }
    const col = column(status).filter((t) => t.id !== id);
    const idx = before ? col.findIndex((t) => t.id === before.id) : col.length;
    actions.patch.mutate({ id, status, position: positionBetween(col[idx - 1]?.position, col[idx]?.position) });
  };

  const stepStatus = (t: Task, dir: -1 | 1) => {
    const next = COLUMNS[COLUMNS.findIndex((c) => c.status === t.status) + dir];
    if (next) move(t.id, next.status);
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Board</h1>
          <p className="sub">Drag cards between columns, or use the arrows.</p>
        </div>
        <div className="page-actions">
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </header>
      {actions.error && <p className="alert" role="alert">{actions.error}</p>}

      <div className="board">
        {COLUMNS.map((c) => {
          const items = column(c.status);
          return (
            <div
              key={c.status}
              className={`column${overCol === c.status ? " over" : ""}`}
              onDragOver={(e) => (e.preventDefault(), setOverCol(c.status))}
              onDragLeave={() => setOverCol(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                if (dragId !== null) move(dragId, c.status);
                setDragId(null);
              }}
            >
              <h2 className="column-head">
                <span className={`dot ${c.status}`} />
                {c.label}
                <span className="count">{items.length}</span>
              </h2>
              {items.map((t) => {
                const due = dueState(t);
                return (
                  <article
                    key={t.id}
                    className={`card-task${dragId === t.id ? " dragging" : ""}${t.status === "done" ? " done" : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOverCol(null);
                      if (dragId !== null) move(dragId, c.status, t);
                      setDragId(null);
                    }}
                  >
                    <button className="title" onClick={() => onOpen(t.id)}>{t.title}</button>
                    <div className="meta">
                      {t.blocked && <span title="Blocked"><Lock size={13} /></span>}
                      {t.priority > 0 && <span className={`pill p${t.priority}`}>{PRIORITY[t.priority]}</span>}
                      {t.subtasks_total > 0 && <span><ListTree size={13} />{t.subtasks_done}/{t.subtasks_total}</span>}
                      {t.due_at && (
                        <span className={due === "overdue" ? "overdue" : ""}><CalendarDays size={13} />{formatDue(t.due_at)}</span>
                      )}
                    </div>
                    <div className="step">
                      <button type="button" className="icon sm" disabled={c.status === "todo"} aria-label="Move left" onClick={() => stepStatus(t, -1)}>
                        <ChevronLeft size={15} />
                      </button>
                      <button type="button" className="icon sm" disabled={c.status === "done"} aria-label="Move right" onClick={() => stepStatus(t, 1)}>
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </article>
                );
              })}
              {items.length === 0 && <p className="hint">{c.status === "done" ? "Completed tasks land here" : "Drop tasks here"}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
