import { useEffect, useRef, useState } from "react";
import type { Person } from "../api";
import { Avatar } from "./Avatar";

interface Props {
  /** People who can be mentioned. */
  members: Person[];
  meId: number;
  initial?: string;
  /** Mentions already attached to the text being edited. */
  initialMentions?: { id: number; name: string }[];
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  placeholder?: string;
  onSubmit: (body: string, mentions: number[]) => void;
  onCancel?: () => void;
}

// "@" at the start or after whitespace, followed by what has been typed of a name so far.
const TRIGGER = /(?:^|\s)@([^\s@]{0,30})$/;

export function CommentComposer({
  members, meId, initial = "", initialMentions = [], submitLabel = "Comment", busy, error, autoFocus, placeholder = "Write a comment… type @ to mention someone", onSubmit, onCancel,
}: Props) {
  const [text, setText] = useState(initial);
  const [picks, setPicks] = useState(() => new Map(initialMentions.map((m) => [m.id, m.name])));
  const [caret, setCaret] = useState(initial.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | null>(null);

  const trigger = TRIGGER.exec(text.slice(0, caret));
  const query = trigger ? trigger[1].toLowerCase() : null;
  const options =
    query === null || dismissed ? [] : members.filter((p) => p.id !== meId && p.name.toLowerCase().includes(query)).slice(0, 6);

  // Put the caret after an inserted mention once React has re-rendered the textarea.
  useEffect(() => {
    if (nextCaret.current !== null && area.current) {
      area.current.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text]);

  const choose = (p: Person) => {
    if (!trigger) return;
    const start = caret - trigger[1].length - 1; // position of the "@"
    const inserted = `@${p.name} `;
    setText(text.slice(0, start) + inserted + text.slice(caret));
    setPicks(new Map(picks).set(p.id, p.name));
    nextCaret.current = start + inserted.length;
    setCaret(start + inserted.length);
    setActive(0);
    area.current?.focus();
  };

  const submit = () => {
    const body = text.trim();
    if (!body || busy) return;
    // Only people whose @name is still in the text are mentioned (the author may have deleted it again).
    const mentions = [...picks].filter(([, name]) => body.includes(`@${name}`)).map(([id]) => id);
    onSubmit(body, mentions);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (e.key === "ArrowDown") return void (e.preventDefault(), setActive((i) => (i + 1) % options.length));
      if (e.key === "ArrowUp") return void (e.preventDefault(), setActive((i) => (i - 1 + options.length) % options.length));
      if (e.key === "Enter" || e.key === "Tab") return void (e.preventDefault(), choose(options[active]));
      if (e.key === "Escape") return void (e.preventDefault(), e.stopPropagation(), setDismissed(true));
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return void (e.preventDefault(), submit());
    if (e.key === "Escape" && onCancel) return void (e.stopPropagation(), onCancel());
  };

  return (
    <div className="composer">
      <div className="composer-field">
        <textarea
          ref={area}
          rows={initial ? 3 : 2}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          aria-label="Comment"
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart), setDismissed(false), setActive(0))}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        {options.length > 0 && (
          <ul className="mention-menu" role="listbox" aria-label="Mention someone">
            {options.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === active}>
                <button type="button" className={i === active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), choose(p))} onMouseEnter={() => setActive(i)}>
                  <Avatar id={p.id} name={p.name} size={20} />
                  <span>{p.name}</span>
                  <span className="muted small">{p.email}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="row-inline">
        <button type="button" disabled={!text.trim() || busy} onClick={submit}>{busy ? "Posting…" : submitLabel}</button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
        <span className="muted small">Ctrl+Enter to send</span>
      </div>
    </div>
  );
}
