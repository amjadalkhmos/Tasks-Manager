import { CalendarDays, Clock, CornerDownRight, ListChecks, ListTree, Lock, MessageSquare, Repeat, Timer, Video } from "lucide-react";
import type { Task } from "../api";
import { usePeople } from "../lib/people";
import { PRIORITY, describeRecurrence, dueState, formatDue, formatMinutes } from "../lib/tasks";
import { Avatar } from "./Avatar";

interface Props {
  task: Task;
  onOpen: (id: number) => void;
  onToggle: (t: Task) => void;
  /** Show a "subtask" marker before the title (used when subtasks appear in flat lists). */
  nested?: boolean;
}

const ICON = 13;

export function TaskRow({ task: t, onOpen, onToggle, nested }: Props) {
  const due = dueState(t);
  const { nameOf } = usePeople();
  return (
    <li className={t.status === "done" ? "done" : ""} data-priority={t.priority}>
      <input
        type="checkbox"
        checked={t.status === "done"}
        disabled={t.blocked && t.status !== "done"}
        title={t.blocked && t.status !== "done" ? "Blocked by unfinished tasks" : undefined}
        aria-label={`Complete ${t.title}`}
        onChange={() => onToggle(t)}
      />
      <button className="title" onClick={() => onOpen(t.id)}>
        {nested && <CornerDownRight size={ICON} className="indent" aria-label="Subtask" />}
        {t.title}
      </button>
      <span className="meta">
        {t.blocked && t.status !== "done" && (
          <span title="Blocked by unfinished tasks"><Lock size={ICON} data-icon="lock" /></span>
        )}
        {t.timer_running && <span title="Timer running"><Timer size={ICON} data-icon="timer" /></span>}
        {t.priority > 0 && <span className={`pill p${t.priority}`}>{PRIORITY[t.priority]}</span>}
        {t.recurrence && (
          <span title={describeRecurrence(t.recurrence)}><Repeat size={ICON} data-icon="repeat" /></span>
        )}
        {t.subtasks_total > 0 && (
          <span title="Subtasks done"><ListTree size={ICON} data-icon="subtasks" />{t.subtasks_done}/{t.subtasks_total}</span>
        )}
        {t.checklist_total > 0 && (
          <span title="Checklist done"><ListChecks size={ICON} data-icon="checklist" />{t.checklist_done}/{t.checklist_total}</span>
        )}
        {t.comment_count > 0 && (
          <span title={`${t.comment_count} comment${t.comment_count === 1 ? "" : "s"}`}><MessageSquare size={ICON} data-icon="comments" />{t.comment_count}</span>
        )}
        {t.meeting_count > 0 && (
          <span title={`${t.meeting_count} meeting${t.meeting_count === 1 ? "" : "s"}`}><Video size={ICON} data-icon="meetings" />{t.meeting_count}</span>
        )}
        {t.estimate_min !== null && (
          <span title="Tracked / estimated"><Clock size={ICON} data-icon="estimate" />{formatMinutes(t.tracked_min)}/{formatMinutes(t.estimate_min)}</span>
        )}
        {t.tags.map((g) => (
          <span className="tag" key={g}>#{g}</span>
        ))}
        {t.assignee_id !== null && <Avatar id={t.assignee_id} name={nameOf(t.assignee_id)} size={20} />}
        {t.due_at && (
          <span className={due === "overdue" ? "overdue" : due === "today" ? "today-due" : ""} title={due === "overdue" ? "Overdue" : undefined}>
            <CalendarDays size={ICON} data-icon="due" />
            {formatDue(t.due_at)}
          </span>
        )}
      </span>
    </li>
  );
}
