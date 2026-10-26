import { useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, ListTree, Lock } from "lucide-react";
import { api, type Task } from "../api";
import { StatusChip } from "../components/StatusChip";
import { BUILTIN, statusOf, statusesFor, useStatuses, type StatusOption } from "../lib/statuses";
import { PRIORITY, dueState, formatDue, positionBetween } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

const DONE_LIMIT = 20;
const colKey = (s: StatusOption) => String(s.id ?? `c:${s.category}`);

export function BoardPage({ onOpen }: { onOpen: (id: number) => void }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const statuses = useStatuses();
  const actions = useTaskActions();
  const [project, setProject] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  const picked = projects.data?.find((p) => p.id === Number(project));
  // With a project chosen the columns are that project's statuses. Across all projects they can differ, so the board
  // falls back to the three built-in categories and each card carries its own status label.
  const columns = picked ? statuses.forPlace(picked.id, picked.workspace_id) : BUILTIN;
  const all = (tasks.data ?? []).filter((t) => t.parent_id === null && (project === "" || t.project_id === Number(project)));

  const inColumn = (t: Task, col: StatusOption) => (picked ? colKey(statusOf(columns, t)) === colKey(col) : t.status === col.category);
  const column = (col: StatusOption) => {
    const items = all.filter((t) => inColumn(t, col));
    return col.category === "done"
      ? items.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")).slice(0, DONE_LIMIT)
      : items.sort((a, b) => a.position - b.position || a.id - b.id);
  };

  /** Move a card into `col`, placed before `before` (or at the end when omitted). */
  const move = (id: number, col: StatusOption, before?: Task) => {
    const task = all.find((t) => t.id === id);
    if (!task || before?.id === id) return;
    if (inColumn(task, col) && !before) return;
    const items = column(col).filter((t) => t.id !== id);
    const idx = before ? items.findIndex((t) => t.id === before.id) : items.length;
    // Without a project chosen the column is a category, so the task's own place decides which status that means.
    const target = picked ? col : (statusesFor(statuses.all, task.project_id, task.workspace_id).find((s) => s.category === col.category) ?? col);
    actions.setStatus.mutate({ task, status: target, position: positionBetween(items[idx - 1]?.position, items[idx]?.position) });
  };

  const stepStatus = (t: Task, dir: -1 | 1) => {
    const here = columns.findIndex((c) => inColumn(t, c));
    const next = columns[here + dir];
    if (next) move(t.id, next);
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Board</h1>
          <p className="sub">
            Drag cards between columns, or use the arrows.
            {!picked && " Choose a project to see its own statuses as columns."}
          </p>
        </div>
        <div className="page-actions">
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project">
            <option value="">All projects</option>
            {projects.data?.filter((p) => p.stage !== "archived" || String(p.id) === project).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </header>
      {actions.error && <p className="alert" role="alert">{actions.error}</p>}

      <div className="board" style={{ "--cols": columns.length } as CSSProperties}>
        {columns.map((c, ci) => {
          const items = column(c);
          const key = colKey(c);
          return (
            <div
              key={key}
              className={`column${overCol === key ? " over" : ""}`}
              onDragOver={(e) => (e.preventDefault(), setOverCol(key))}
              onDragLeave={() => setOverCol(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                if (dragId !== null) move(dragId, c);
                setDragId(null);
              }}
            >
              <h2 className="column-head">
                <span className="dot" style={{ background: c.color }} />
                {c.name}
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
                      if (dragId !== null) move(dragId, c, t);
                      setDragId(null);
                    }}
                  >
                    <button className="title" onClick={() => onOpen(t.id)}>{t.title}</button>
                    <div className="meta">
                      {!picked && <StatusChip status={statuses.of(t)} />}
                      {t.blocked && <span title="Blocked"><Lock size={13} /></span>}
                      {t.priority > 0 && <span className={`pill p${t.priority}`}>{PRIORITY[t.priority]}</span>}
                      {t.subtasks_total > 0 && <span><ListTree size={13} />{t.subtasks_done}/{t.subtasks_total}</span>}
                      {t.due_at && (
                        <span className={due === "overdue" ? "overdue" : ""}><CalendarDays size={13} />{formatDue(t.due_at)}</span>
                      )}
                    </div>
                    <div className="step">
                      <button type="button" className="icon sm" disabled={ci === 0} aria-label="Move left" onClick={() => stepStatus(t, -1)}>
                        <ChevronLeft size={15} />
                      </button>
                      <button type="button" className="icon sm" disabled={ci === columns.length - 1} aria-label="Move right" onClick={() => stepStatus(t, 1)}>
                        <ChevronRight size={15} />
                      </button>
                    </div>
                  </article>
                );
              })}
              {items.length === 0 && <p className="hint">{c.category === "done" ? "Completed tasks land here" : "Drop tasks here"}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
