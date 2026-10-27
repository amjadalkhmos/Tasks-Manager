import { useState, type CSSProperties } from "react";
import { Diamond } from "lucide-react";
import type { MilestoneProgress, Project, Task } from "../api";
import { parseDay } from "../lib/projects";
import { useStatuses } from "../lib/statuses";

const DAY_MS = 86_400_000;
const ZOOM = { Days: 28, Weeks: 12, Months: 4 } as const;
type Zoom = keyof typeof ZOOM;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayIndex = (d: Date, origin: Date) => Math.round((startOfDay(d).getTime() - origin.getTime()) / DAY_MS);
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

interface Bar {
  task: Task;
  from: number;
  to: number; // inclusive day
}

/**
 * The plan over time: each task with a start and/or due date is a bar, grouped under the milestone it belongs to, with
 * the milestones themselves marked on their dates. Tasks without a date wait in a list underneath. Click a bar to open
 * the task; set its dates from the task panel.
 */
export function Timeline({ project, tasks, milestones, onOpen }: { project: Project; tasks: Task[]; milestones: MilestoneProgress[]; onOpen: (id: number) => void }) {
  const [zoom, setZoom] = useState<Zoom>("Weeks");
  const statuses = useStatuses();
  const px = ZOOM[zoom];
  const today = startOfDay(new Date());

  const top = tasks.filter((t) => t.parent_id === null);
  const bars: Bar[] = [];
  const unscheduled: Task[] = [];
  const stamps: Date[] = [today];
  if (project.start_date) stamps.push(parseDay(project.start_date));
  if (project.target_date) stamps.push(parseDay(project.target_date));
  for (const m of milestones) {
    if (m.due_date) stamps.push(parseDay(m.due_date));
    if (m.baseline_date) stamps.push(parseDay(m.baseline_date));
  }
  for (const t of top) {
    const s = t.start_at ? new Date(t.start_at) : null;
    const d = t.due_at ? new Date(t.due_at) : null;
    if (!s && !d) {
      unscheduled.push(t);
      continue;
    }
    const from = startOfDay((s ?? d)!);
    const to = startOfDay((d ?? s)!);
    stamps.push(from, to);
    bars.push({ task: t, from: 0, to: 0 });
  }
  const min = new Date(Math.min(...stamps.map((d) => d.getTime())));
  const max = new Date(Math.max(...stamps.map((d) => d.getTime())));
  const origin = addDays(startOfDay(min), -3 - ((startOfDay(min).getDay() + 6) % 7)); // pad, then back to a Monday
  const days = Math.max(14, dayIndex(max, origin) + 10);
  const width = days * px;
  const placed = bars.map((b) => {
    const s = b.task.start_at ? new Date(b.task.start_at) : null;
    const d = b.task.due_at ? new Date(b.task.due_at) : null;
    return { ...b, from: dayIndex((s ?? d)!, origin), to: dayIndex((d ?? s)!, origin) };
  });

  const byMilestone = new Map<number | null, Bar[]>();
  for (const b of placed) byMilestone.set(b.task.milestone_id, [...(byMilestone.get(b.task.milestone_id) ?? []), b]);
  const groups: { key: string; milestone: MilestoneProgress | null; bars: Bar[] }[] = [
    ...milestones.map((m) => ({ key: `m${m.id}`, milestone: m, bars: byMilestone.get(m.id) ?? [] })),
    { key: "none", milestone: null, bars: byMilestone.get(null) ?? [] },
  ].filter((g) => g.milestone !== null || g.bars.length > 0);
  for (const g of groups) g.bars.sort((a, b) => a.from - b.from || a.to - b.to);

  // Axis: a label at the first day of each month, a tick each Monday.
  const months: { left: number; label: string }[] = [];
  const weeks: number[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(origin, i);
    if (d.getDate() === 1 || i === 0) months.push({ left: i * px, label: d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) });
    if (d.getDay() === 1) weeks.push(i * px);
  }
  const todayLeft = dayIndex(today, origin) * px + px / 2;
  const track = { width } as CSSProperties;

  if (placed.length === 0 && milestones.length === 0) {
    return (
      <div className="empty compact">
        <h2>Nothing to plan yet</h2>
        <p>Give tasks a start and due date in the task panel, and add milestones from Overview. They appear here as a plan over time.</p>
        {unscheduled.length > 0 && <Unscheduled tasks={unscheduled} onOpen={onOpen} />}
      </div>
    );
  }

  return (
    <div className="timeline-wrap">
      <div className="timeline-tools">
        <span className="muted small">Click a bar to open the task.</span>
        <div className="chip-row" role="group" aria-label="Zoom" style={{ marginBottom: 0 }}>
          {(Object.keys(ZOOM) as Zoom[]).map((z) => (
            <button key={z} type="button" className={`chip${zoom === z ? " on" : ""}`} aria-pressed={zoom === z} onClick={() => setZoom(z)}>{z}</button>
          ))}
        </div>
      </div>

      <div className="gantt" role="table" aria-label="Project timeline">
        <div className="g-row g-axis" role="row">
          <div className="g-label" role="columnheader" />
          <div className="g-track" style={track}>
            {months.map((m) => <span key={m.left} className="g-month" style={{ left: m.left }}>{m.label}</span>)}
            {weeks.map((w) => <span key={w} className="g-week" style={{ left: w }} />)}
          </div>
        </div>

        {groups.map((g) => (
          <div key={g.key}>
            <div className="g-row g-group" role="row">
              <div className="g-label" role="rowheader" title={g.milestone?.name ?? "No milestone"}>
                <strong>{g.milestone ? g.milestone.name : "No milestone"}</strong>
                {g.milestone && g.milestone.tasks_total > 0 && <span className="muted small">{g.milestone.tasks_done}/{g.milestone.tasks_total}</span>}
              </div>
              <div className="g-track" style={track}>
                {weeks.map((w) => <span key={w} className="g-week" style={{ left: w }} />)}
                <span className="g-today" style={{ left: todayLeft }} />
                {g.milestone?.baseline_date && g.milestone.due_date && g.milestone.baseline_date !== g.milestone.due_date && (
                  <span
                    className="g-milestone baseline"
                    style={{ left: dayIndex(parseDay(g.milestone.baseline_date), origin) * px + px / 2 }}
                    title={`${g.milestone.name} · baseline ${g.milestone.baseline_date}`}
                    aria-hidden="true"
                  >
                    <Diamond size={16} />
                  </span>
                )}
                {g.milestone?.due_date && (
                  <span
                    className={`g-milestone ${g.milestone.state}`}
                    style={{ left: dayIndex(parseDay(g.milestone.due_date), origin) * px + px / 2 }}
                    title={`${g.milestone.name} · ${g.milestone.due_date}${g.milestone.state === "at_risk" ? ` · at risk: ${g.milestone.risks[0] ?? ""}` : g.milestone.state === "upcoming" ? "" : ` · ${g.milestone.state}`}`}
                  >
                    <Diamond size={16} />
                  </span>
                )}
              </div>
            </div>
            {g.bars.map((b) => {
              const st = statuses.of(b.task);
              const late = b.task.status !== "done" && !!b.task.due_at && new Date(b.task.due_at) < new Date();
              return (
                <div className="g-row" role="row" key={b.task.id}>
                  <div className="g-label" role="rowheader">
                    <button type="button" className="g-title" onClick={() => onOpen(b.task.id)}>{b.task.title}</button>
                  </div>
                  <div className="g-track" style={track}>
                    {weeks.map((w) => <span key={w} className="g-week" style={{ left: w }} />)}
                    <span className="g-today" style={{ left: todayLeft }} />
                    <button
                      type="button"
                      className={`g-bar${b.task.status === "done" ? " done" : ""}${late ? " late" : ""}`}
                      style={{ left: b.from * px, width: Math.max(px, (b.to - b.from + 1) * px), ["--c" as string]: st.color } as CSSProperties}
                      title={`${b.task.title} · ${st.name}`}
                      onClick={() => onOpen(b.task.id)}
                    >
                      <span>{st.name}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {unscheduled.length > 0 && <Unscheduled tasks={unscheduled} onOpen={onOpen} />}
    </div>
  );
}

function Unscheduled({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: number) => void }) {
  const open = tasks.filter((t) => t.status !== "done");
  if (open.length === 0) return null;
  return (
    <section className="panel" aria-label="Unscheduled tasks" style={{ marginTop: 16 }}>
      <h2>Not scheduled yet <span className="muted small">{open.length}</span></h2>
      <p className="muted small">These have no start or due date, so they aren't on the timeline.</p>
      <ul className="unscheduled">
        {open.map((t) => (
          <li key={t.id}><button type="button" className="link" onClick={() => onOpen(t.id)}>{t.title}</button></li>
        ))}
      </ul>
    </section>
  );
}
