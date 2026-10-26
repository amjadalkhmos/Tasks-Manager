import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarSync, Download, FileUp, Mail, Plug, RefreshCw, Smartphone, Sparkles, Unplug } from "lucide-react";
import { api, type ImportFormat, type ImportSummary } from "../api";
import { useTaskActions } from "../lib/useTaskActions";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** Captures Chrome's install prompt so it can be offered from a button instead of the browser's own timing. */
function useInstallPrompt() {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia("(display-mode: standalone)").matches);
  useEffect(() => {
    const onPrompt = (e: Event) => (e.preventDefault(), setEvent(e as InstallPromptEvent));
    const onInstalled = () => (setInstalled(true), setEvent(null));
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return { installed, canInstall: !!event, install: () => event?.prompt().then(() => setEvent(null)) };
}

const FORMATS: { value: ImportFormat; label: string; hint: string; accept: string; wantsProject: boolean }[] = [
  { value: "json", label: "This app's export (JSON)", hint: "Restores tasks, subtasks, tags, checklists, dependencies, repeats and smart lists.", accept: ".json,application/json", wantsProject: false },
  { value: "csv", label: "Spreadsheet (CSV)", hint: "Needs a title column. Optional: notes, project, priority, status, due_at, tags.", accept: ".csv,text/csv", wantsProject: true },
  { value: "todoist", label: "Todoist (CSV)", hint: "A project exported from Todoist. Subtasks and priorities are kept; repeat rules are not.", accept: ".csv,text/csv", wantsProject: true },
  { value: "trello", label: "Trello (JSON)", hint: "A board exported from Trello. Lists become statuses, labels become tags.", accept: ".json,application/json", wantsProject: false },
];

function ImportSection() {
  const actions = useTaskActions();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<ImportFormat>("json");
  const [project, setProject] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const spec = FORMATS.find((f) => f.value === format)!;

  const run = useMutation<ImportSummary>({
    mutationFn: () => api.importFile(format, file!, spec.wantsProject ? project.trim() || undefined : undefined),
    onSuccess: () => {
      setFile(null);
      if (input.current) input.current.value = "";
      void actions.refresh();
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["filters"] });
    },
  });

  return (
    <section className="panel">
      <h2>Import</h2>
      <p className="muted setting-help">Bring tasks in from another tool. Nothing is overwritten — imported tasks are added alongside what you have.</p>
      <div className="setting-form">
        <label>
          Format
          <select value={format} onChange={(e) => (setFormat(e.target.value as ImportFormat), setFile(null), run.reset())}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <span className="muted small">{spec.hint}</span>
        </label>
        {spec.wantsProject && (
          <label>
            Put them in project <span className="muted">(optional)</span>
            <input value={project} maxLength={100} placeholder={format === "todoist" ? "Todoist import" : "Leave empty to use the file's project column"} onChange={(e) => setProject(e.target.value)} />
          </label>
        )}
        <label>
          File
          <input ref={input} type="file" accept={spec.accept} onChange={(e) => (setFile(e.target.files?.[0] ?? null), run.reset())} />
        </label>
        <div>
          <button type="button" disabled={!file || run.isPending} onClick={() => run.mutate()}>
            <FileUp size={15} /> {run.isPending ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
      {run.error && <p className="alert" role="alert">{run.error.message}</p>}
      {run.data && (
        <div className="result" role="status">
          <strong>Imported {run.data.tasks} task{run.data.tasks === 1 ? "" : "s"}</strong>
          {run.data.projects > 0 && ` and ${run.data.projects} new project${run.data.projects === 1 ? "" : "s"}`}
          {run.data.filters > 0 && `, ${run.data.filters} smart list${run.data.filters === 1 ? "" : "s"}`}.
          {run.data.warnings.length > 0 && (
            <ul className="warnings">
              {run.data.warnings.slice(0, 8).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {run.data.warnings.length > 8 && <li>…and {run.data.warnings.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function GoogleSection() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const actions = useTaskActions();
  const status = useQuery({ queryKey: ["integrations"], queryFn: api.integrations });
  const g = status.data?.google;
  const [label, setLabel] = useState<string | null>(null);
  const flash = params.get("google");

  const connect = useMutation({
    mutationFn: api.googleConnectUrl,
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const save = useMutation({
    mutationFn: api.googleSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });
  const sync = useMutation({
    mutationFn: api.googleSync,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      void actions.refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: api.googleDisconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integrations"] }),
  });

  return (
    <section className="panel">
      <h2>Google Calendar &amp; Gmail</h2>
      {flash === "connected" && <p className="result" role="status">Google connected. Choose what to sync below, then press “Sync now”.</p>}
      {flash === "error" && (
        <p className="alert" role="alert">
          Couldn't connect to Google. Try again; if it keeps failing, check the server's Google credentials.
          <button className="link" onClick={() => setParams({})}>Dismiss</button>
        </p>
      )}
      {status.isLoading && <p className="muted">Loading…</p>}
      {g && !g.configured && (
        <p className="muted setting-help">
          Not set up on this server. To enable it, create a Google OAuth client and set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and{" "}
          <code>PUBLIC_URL</code> (and <code>TOKEN_ENC_KEY</code> in production) in the server's environment.
        </p>
      )}
      {g?.configured && !g.connected && (
        <>
          <p className="muted setting-help">
            Show tasks that have due dates on your Google Calendar (changes to the date flow both ways) and turn emails you label into tasks.
          </p>
          <button type="button" onClick={() => connect.mutate()} disabled={connect.isPending}>
            <Plug size={15} /> Connect Google
          </button>
        </>
      )}
      {g?.connected && (
        <div className="setting-form">
          <p>Connected as <strong>{g.account ?? "your Google account"}</strong></p>
          <label className="check-row">
            <input type="checkbox" checked={g.settings.calendar} onChange={(e) => save.mutate({ calendar: e.target.checked })} />
            <span><CalendarSync size={15} /> Sync tasks with due dates to Google Calendar</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={g.settings.gmail} onChange={(e) => save.mutate({ gmail: e.target.checked })} />
            <span><Mail size={15} /> Turn emails with this Gmail label into tasks</span>
          </label>
          {g.settings.gmail && (
            <label>
              Gmail label
              <input
                value={label ?? g.settings.gmailLabel}
                maxLength={100}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => label !== null && label.trim() && label !== g.settings.gmailLabel && save.mutate({ gmailLabel: label.trim() }, { onSettled: () => setLabel(null) })}
              />
            </label>
          )}
          <div className="row-inline">
            <button type="button" onClick={() => sync.mutate()} disabled={sync.isPending}>
              <RefreshCw size={15} /> {sync.isPending ? "Syncing…" : "Sync now"}
            </button>
            <button type="button" className="secondary" onClick={() => confirm("Disconnect Google? Events already on your calendar are left in place.") && disconnect.mutate()}>
              <Unplug size={15} /> Disconnect
            </button>
            <span className="muted small">{g.last_sync ? `Last synced ${new Date(g.last_sync).toLocaleString()}` : "Not synced yet"}</span>
          </div>
          {sync.data && (
            <p className="result" role="status">
              {sync.data.calendar &&
                `Calendar: ${sync.data.calendar.created} added, ${sync.data.calendar.updated} updated, ${sync.data.calendar.pulled} changed from Google, ${sync.data.calendar.removed} removed. `}
              {sync.data.gmail && `Gmail: ${sync.data.gmail.imported} new task${sync.data.gmail.imported === 1 ? "" : "s"}.`}
              {!sync.data.calendar && !sync.data.gmail && "Nothing to sync — turn on calendar sync or Gmail import first."}
            </p>
          )}
        </div>
      )}
      {(connect.error || save.error || sync.error || disconnect.error) && (
        <p className="alert" role="alert">{(connect.error ?? save.error ?? sync.error ?? disconnect.error)!.message}</p>
      )}
    </section>
  );
}

function ProfileSection() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me }).data;
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (n: string) => api.updateProfile(n),
    onSuccess: () => (setName(null), Promise.all(["me", "people", "workspace"].map((k) => qc.invalidateQueries({ queryKey: [k] })))),
  });
  const value = name ?? me?.name ?? "";
  return (
    <section className="panel">
      <h2>Profile</h2>
      <p className="muted setting-help">Teammates see this name next to your comments, assignments and activity. Your email is {me?.email}.</p>
      <form className="invite-form" onSubmit={(e) => (e.preventDefault(), name !== null && save.mutate(name.trim()))}>
        <input aria-label="Display name" maxLength={60} value={value} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={name === null || save.isPending}>Save</button>
      </form>
      {save.error && <p className="alert" role="alert">{save.error.message}</p>}
    </section>
  );
}

export function SettingsPage() {
  const ai = useQuery({ queryKey: ["ai-status"], queryFn: api.aiStatus });
  const install = useInstallPrompt();

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="sub">Your data, integrations and install options.</p>
        </div>
      </header>

      <ProfileSection />

      <section className="panel">
        <h2>Use it like an app</h2>
        <p className="muted setting-help">
          Install this on your phone or computer to open it from the home screen or taskbar. Once opened, it keeps working without a connection:
          you can read your tasks and add, edit, complete or delete them, and the changes sync when you're back online.
        </p>
        {install.installed ? (
          <p className="result"><Smartphone size={15} /> You're using the installed app.</p>
        ) : install.canInstall ? (
          <button type="button" onClick={() => void install.install()}><Download size={15} /> Install app</button>
        ) : (
          <p className="muted small">Your browser's menu has an “Install” or “Add to home screen” option for this page.</p>
        )}
      </section>

      <section className="panel">
        <h2>Export</h2>
        <p className="muted setting-help">Download everything you've entered. JSON is complete and can be imported back; CSV opens in a spreadsheet.</p>
        <div className="row-inline">
          <a className="btn secondary" href="/api/export" download="tasks-export.json"><Download size={15} /> JSON (complete)</a>
          <a className="btn secondary" href="/api/export.csv" download="tasks-export.csv"><Download size={15} /> CSV (spreadsheet)</a>
        </div>
      </section>

      <ImportSection />

      <section className="panel">
        <h2>AI assistant</h2>
        {ai.data?.enabled ? (
          <p className="muted setting-help">
            <Sparkles size={14} style={{ verticalAlign: "-2px" }} /> On. Open a task and choose “Suggest subtasks”, or press “Plan my day” on Today. Only the task you ask about
            (or your open task titles, dates and priorities for the day plan) is sent, and only when you press the button.
          </p>
        ) : (
          <p className="muted setting-help">
            Off. The server owner can enable it by setting <code>ANTHROPIC_API_KEY</code> on the server. It adds subtask suggestions and a daily plan.
          </p>
        )}
      </section>

      <GoogleSection />
    </div>
  );
}
