import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BookmarkCheck, CalendarClock, CalendarDays, ChartNoAxesColumn, CircleCheck, Circle, Folder, FolderKanban, Inbox, KanbanSquare, ListTodo, Plus, Search, Sun, Video,
} from "lucide-react";
import { api } from "../api";
import { parseQuickAdd } from "../lib/quickAdd";
import { useTaskActions } from "../lib/useTaskActions";

interface Command {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

const I = 16;
const PAGES: [string, string, ReactNode][] = [
  ["Inbox", "/", <Inbox size={I} />],
  ["Today", "/today", <Sun size={I} />],
  ["Upcoming", "/upcoming", <CalendarClock size={I} />],
  ["All tasks", "/all", <ListTodo size={I} />],
  ["Board", "/board", <KanbanSquare size={I} />],
  ["Calendar", "/calendar", <CalendarDays size={I} />],
  ["My work", "/my-work", <ListTodo size={I} />],
  ["Needs attention", "/attention", <Inbox size={I} />],
  ["Projects overview", "/projects", <FolderKanban size={I} />],
  ["Meetings", "/meetings", <Video size={I} />],
  ["Dashboard", "/dashboard", <ChartNoAxesColumn size={I} />],
];
const MAX_RESULTS = 8;

export function CommandPalette({ onClose, onOpenTask }: { onClose: () => void; onOpenTask: (id: number) => void }) {
  const navigate = useNavigate();
  const actions = useTaskActions();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const filters = useQuery({ queryKey: ["filters"], queryFn: api.filters });
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const create = useMutation({
    mutationFn: (raw: string) => {
      const p = parseQuickAdd(raw);
      const project = p.project ? projects.data?.find((x) => x.name.toLowerCase() === p.project!.toLowerCase()) : undefined;
      return api.createTask({
        title: p.title,
        priority: p.priority,
        tags: p.tags,
        recurrence: p.recurrence,
        project_id: project?.id ?? null,
        due_at: p.due_at,
      });
    },
    onSuccess: async () => {
      await actions.refresh();
      onClose();
    },
  });

  const commands = useMemo<Command[]>(() => {
    const q = text.trim().toLowerCase();
    const go = (path: string) => () => (navigate(path), onClose());
    const nav: Command[] = [
      ...PAGES.map(([label, path, icon]) => ({ key: `page:${path}`, label: `Go to ${label}`, icon, run: go(path) })),
      ...(projects.data ?? []).map((p) => ({
        key: `project:${p.id}`,
        label: `Project: ${p.name}`,
        icon: <Folder size={I} />,
        run: go(`/project/${p.id}`),
      })),
      ...(filters.data ?? []).map((f) => ({
        key: `filter:${f.id}`,
        label: `Smart list: ${f.name}`,
        icon: <BookmarkCheck size={I} />,
        run: go(`/filter/${f.id}`),
      })),
    ];
    const found: Command[] = q
      ? (tasks.data ?? [])
          .filter((t) => t.title.toLowerCase().includes(q))
          .slice(0, 5)
          .map((t) => ({
            key: `task:${t.id}`,
            label: t.title,
            hint: t.status === "done" ? "Done" : "Task",
            icon: t.status === "done" ? <CircleCheck size={I} /> : <Circle size={I} />,
            run: () => (onOpenTask(t.id), onClose()),
          }))
      : [];
    const add: Command[] = q
      ? [{ key: "create", label: `Create task: “${text.trim()}”`, hint: "Enter", icon: <Plus size={I} />, run: () => create.mutate(text.trim()) }]
      : [];
    return [...found, ...nav.filter((c) => !q || c.label.toLowerCase().includes(q)), ...add].slice(0, MAX_RESULTS + 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, tasks.data, projects.data, filters.data]);

  useEffect(() => setIndex(0), [text]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(i + 1, commands.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
    else if (e.key === "Enter") (e.preventDefault(), commands[index]?.run());
  };

  return (
    <div className="backdrop top" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search tasks, jump to a page, or type a new task…"
            aria-label="Command"
          />
        </div>
        <ul role="listbox">
          {commands.map((c, i) => (
            <li key={c.key} role="option" aria-selected={i === index}>
              <button type="button" className={i === index ? "active" : ""} onMouseEnter={() => setIndex(i)} onClick={c.run}>
                {c.icon}
                <span>{c.label}</span>
                {c.hint && <span className="hint">{c.hint}</span>}
              </button>
            </li>
          ))}
          {commands.length === 0 && <li className="none">No matches</li>}
        </ul>
        {create.error && <p className="alert" role="alert" style={{ margin: "0 6px 6px" }}>{create.error.message}</p>}
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
          <span><kbd>n</kbd> add a task from anywhere</span>
        </div>
      </div>
    </div>
  );
}
