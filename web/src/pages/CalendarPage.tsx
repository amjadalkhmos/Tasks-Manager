import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../api";
import { dueState, startOfDay } from "../lib/tasks";
import { useTaskActions } from "../lib/useTaskActions";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PER_DAY = 3;

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function CalendarPage({ onOpen }: { onOpen: (id: number) => void }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const actions = useTaskActions();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragId, setDragId] = useState<number | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);

  // Six full weeks starting on the Sunday on/before the 1st, so the grid height never jumps.
  const gridStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - cursor.getDay());
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));

  const byDay = new Map<string, NonNullable<typeof tasks.data>>();
  for (const t of tasks.data ?? []) {
    if (!t.due_at) continue;
    const k = dayKey(new Date(t.due_at));
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }

  const reschedule = (id: number, day: Date) => {
    const task = tasks.data?.find((t) => t.id === id);
    if (!task?.due_at) return;
    const old = new Date(task.due_at);
    if (dayKey(old) === dayKey(day)) return;
    // Keep the time of day; only the date changes.
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old.getHours(), old.getMinutes());
    actions.patch.mutate({ id, due_at: next.toISOString() });
  };

  const today = dayKey(startOfDay(new Date()));
  const shift = (n: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const goToday = () => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>{cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h1>
          <p className="sub">Drag a task to another day to reschedule it.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="secondary" onClick={goToday}>Today</button>
          <div className="segmented">
            <button type="button" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <button type="button" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} /></button>
          </div>
        </div>
      </header>
      {actions.error && <p className="alert" role="alert">{actions.error}</p>}

      <div className="calendar" role="grid">
        {DAY_NAMES.map((n) => (
          <div key={n} className="cal-head" role="columnheader">{n}</div>
        ))}
        {days.map((d) => {
          const k = dayKey(d);
          const items = byDay.get(k) ?? [];
          return (
            <div
              key={k}
              role="gridcell"
              className={`cal-day${d.getMonth() !== cursor.getMonth() ? " other" : ""}${k === today ? " today" : ""}${overDay === k ? " over" : ""}`}
              onDragOver={(e) => (e.preventDefault(), setOverDay(k))}
              onDragLeave={() => setOverDay(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOverDay(null);
                if (dragId !== null) reschedule(dragId, d);
                setDragId(null);
              }}
            >
              <span className="cal-num">{d.getDate()}</span>
              {items.slice(0, MAX_PER_DAY).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  draggable
                  data-priority={t.priority}
                  className={`cal-task${t.status === "done" ? " done" : ""}${dueState(t) === "overdue" ? " overdue" : ""}`}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => onOpen(t.id)}
                  title={t.title}
                >
                  {t.title}
                </button>
              ))}
              {items.length > MAX_PER_DAY && <span className="cal-more">+{items.length - MAX_PER_DAY} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
