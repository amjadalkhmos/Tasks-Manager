import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DuplicateError, salesApi, type ImportPreview, type ImportResult, type LeadDetail } from "../../api";
import { useRefreshSales, useSales } from "../../lib/sales";
import { Dialog, DuplicateNotice, ErrorLine, OwnerSelect } from "./bits";

const defaultOwner = (me: ReturnType<typeof useSales>["me"]): number | null =>
  me.assignable.owners.some((o) => o.id === me.user_id) ? me.user_id : me.assignable.unassigned ? null : (me.assignable.owners[0]?.id ?? null);

export function NewLeadDialog({ onClose }: { onClose: () => void }) {
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "", job_title: "", notes: "" });
  const [owner, setOwner] = useState<number | null>(defaultOwner(me));
  const [dup, setDup] = useState<DuplicateError | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const save = useMutation({
    mutationFn: (force: boolean) => salesApi.createLead({ workspace_id: wid, ...f, name: f.name.trim(), email: f.email.trim(), owner_id: owner, ...(force ? { allow_duplicate: true } : {}) }),
    onError: (e) => setDup(e instanceof DuplicateError ? e : null),
    onSuccess: async (l) => {
      await refresh();
      onClose();
      navigate(`/sales/${wid}/leads/${l.id}`);
    },
  });
  return (
    <Dialog title="New lead" onClose={onClose}>
      <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), setDup(null), f.name.trim() && save.mutate(false))}>
        <div className="two">
          <label>Name<input autoFocus required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label>Email<input type="email" maxLength={200} value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
        </div>
        <div className="two">
          <label>Company<input maxLength={200} value={f.company} onChange={(e) => set({ company: e.target.value })} /></label>
          <label>Job title<input maxLength={100} value={f.job_title} onChange={(e) => set({ job_title: e.target.value })} /></label>
        </div>
        <div className="two">
          <label>Phone<input maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
          <OwnerSelect me={me} value={owner} onChange={setOwner} />
        </div>
        <label>Notes<textarea rows={2} maxLength={5000} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
        {dup && <DuplicateNotice dup={dup} busy={save.isPending} onForce={() => save.mutate(true)} />}
        <ErrorLine error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!f.name.trim() || save.isPending}>Add lead</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Turning a lead into an account, a contact and (optionally) a deal. */
export function QualifyDialog({ lead, onClose }: { lead: LeadDetail; onClose: () => void }) {
  const { workspaceId: wid, me, pipelines } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const accounts = useQuery({ queryKey: ["sales", "accounts", wid, "all"], queryFn: () => salesApi.accounts(wid) });
  const [mode, setMode] = useState<"new" | "existing" | "none">(lead.company ? "new" : "none");
  const [name, setName] = useState(lead.company);
  const [existing, setExisting] = useState("");
  const [contact, setContact] = useState(true);
  const [makeDeal, setMakeDeal] = useState(true);
  const [title, setTitle] = useState(lead.company ? `${lead.company} – opportunity` : `${lead.name} – opportunity`);
  const [pipeline, setPipeline] = useState(pipelines[0]?.id ?? 0);
  const [value, setValue] = useState("");
  const [close, setClose] = useState("");
  const [dealOwner, setDealOwner] = useState<number | null>(lead.owner_id ?? defaultOwner(me));
  const [dup, setDup] = useState<DuplicateError | null>(null);

  const save = useMutation({
    mutationFn: (force: boolean) =>
      salesApi.qualifyLead(lead.id, {
        ...(mode === "existing" ? { account: { id: Number(existing) } } : mode === "new" ? { account: { name: name.trim() } } : {}),
        create_contact: contact,
        deal: makeDeal ? { title: title.trim(), pipeline_id: pipeline, owner_id: dealOwner, ...(value ? { value: Number(value) } : {}), ...(close ? { expected_close: close } : {}) } : null,
        ...(force ? { allow_duplicate: true } : {}),
      }),
    onError: (e) => setDup(e instanceof DuplicateError ? e : null),
    onSuccess: async (r) => {
      await refresh();
      onClose();
      navigate(r.deal_id ? `/sales/${wid}/deals/${r.deal_id}` : r.account_id ? `/sales/${wid}/accounts/${r.account_id}` : `/sales/${wid}/leads/${lead.id}`);
    },
  });
  const ready = (mode !== "existing" || existing) && (mode !== "new" || name.trim()) && (!makeDeal || (title.trim() && pipeline));

  return (
    <Dialog title={`Qualify ${lead.name}`} onClose={onClose}>
      <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), setDup(null), ready && save.mutate(false))}>
        <fieldset className="choice">
          <legend>Account</legend>
          <label className="check"><input type="radio" name="acct" checked={mode === "new"} onChange={() => setMode("new")} /> Create a new account</label>
          {mode === "new" && <input aria-label="Account name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />}
          <label className="check"><input type="radio" name="acct" checked={mode === "existing"} onChange={() => setMode("existing")} /> Add to an existing account</label>
          {mode === "existing" && (
            <select aria-label="Existing account" required value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="" disabled>Choose an account…</option>
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <label className="check"><input type="radio" name="acct" checked={mode === "none"} onChange={() => setMode("none")} /> No account for now</label>
        </fieldset>
        <label className="check"><input type="checkbox" checked={contact} onChange={(e) => setContact(e.target.checked)} /> Keep {lead.name} as a contact</label>

        <fieldset className="choice">
          <legend><label className="check"><input type="checkbox" checked={makeDeal} onChange={(e) => setMakeDeal(e.target.checked)} /> Open a deal</label></legend>
          {makeDeal && (
            <>
              <label>Deal<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <div className="two">
                <label>
                  Pipeline
                  <select value={pipeline} onChange={(e) => setPipeline(Number(e.target.value))}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                </label>
                <OwnerSelect me={me} value={dealOwner} onChange={setDealOwner} label="Deal owner" />
              </div>
              <div className="two">
                <label>Value<input type="number" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} /></label>
                <label>Expected close<input type="date" value={close} onChange={(e) => setClose(e.target.value)} /></label>
              </div>
            </>
          )}
        </fieldset>
        {dup && <DuplicateNotice dup={dup} busy={save.isPending} onForce={() => save.mutate(true)} />}
        <ErrorLine error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!ready || save.isPending}>Qualify</button>
        </div>
      </form>
    </Dialog>
  );
}

const FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: "name", label: "Name", required: true },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
  { key: "job_title", label: "Job title" },
  { key: "source_detail", label: "Where it came from" },
  { key: "notes", label: "Notes" },
];

/** Bringing leads in from a spreadsheet: pick the file, say which column is which, and see what happened. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { workspaceId: wid, me } = useSales();
  const refresh = useRefreshSales();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [owner, setOwner] = useState<number | null>(me.manager && me.assignable.unassigned ? null : defaultOwner(me));
  const [dupes, setDupes] = useState<"skip" | "create">("skip");
  const [result, setResult] = useState<ImportResult | null>(null);

  const read = useMutation({
    mutationFn: async (file: File) => {
      const text = await file.text();
      const p = await salesApi.importPreview(wid, text);
      return { text, p, name: file.name };
    },
    onSuccess: ({ text, p, name }) => {
      setCsv(text);
      setFileName(name);
      setPreview(p);
      setMapping(p.suggested);
    },
  });
  const run = useMutation({
    mutationFn: () => salesApi.importLeads({ workspace_id: wid, csv, mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)), owner_id: owner, on_duplicate: dupes, source_detail: fileName ? fileName.slice(0, 200) : undefined }),
    onSuccess: async (r) => {
      setResult(r);
      await refresh();
    },
  });

  return (
    <Dialog title="Import leads from CSV" onClose={onClose} wide>
      {result ? (
        <div className="settings-form" style={{ maxWidth: "none" }}>
          <p role="status"><strong>{result.created}</strong> lead{result.created === 1 ? "" : "s"} added{result.skipped ? `, ${result.skipped} skipped as already known` : ""}{result.failed ? `, ${result.failed} couldn't be read` : ""}.</p>
          {result.errors.length > 0 && (
            <ul className="plain-list">{result.errors.map((e) => <li key={e.row}><span className="muted small">Row {e.row}</span> {e.message}</li>)}</ul>
          )}
          <div className="dialog-actions"><button type="button" onClick={onClose}>Done</button></div>
        </div>
      ) : !preview ? (
        <div className="settings-form" style={{ maxWidth: "none" }}>
          <p className="muted">Choose a CSV file with a header row. You'll match its columns to lead fields next. Up to 5,000 rows at a time.</p>
          <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => e.target.files?.[0] && read.mutate(e.target.files[0])} />
          <ErrorLine error={read.error} />
        </div>
      ) : (
        <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), mapping.name && run.mutate())}>
          <p className="muted"><strong>{fileName}</strong> · {preview.rows} row{preview.rows === 1 ? "" : "s"}</p>
          <div className="map-grid">
            {FIELDS.map((fd) => (
              <label key={fd.key}>
                {fd.label}{fd.required ? " *" : ""}
                <select value={mapping[fd.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [fd.key]: e.target.value })}>
                  <option value="">{fd.required ? "Choose a column…" : "Don't import"}</option>
                  {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          {preview.sample.length > 0 && mapping.name && (
            <p className="muted small">First row: {preview.sample[0][mapping.name.toLowerCase()]}{mapping.email ? ` · ${preview.sample[0][mapping.email.toLowerCase()]}` : ""}</p>
          )}
          <div className="two">
            <OwnerSelect me={me} value={owner} onChange={setOwner} label="Give them to" />
            <label>
              If the email is already known
              <select value={dupes} onChange={(e) => setDupes(e.target.value as "skip" | "create")}>
                <option value="skip">Skip it</option>
                <option value="create">Add it anyway</option>
              </select>
            </label>
          </div>
          <ErrorLine error={run.error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setPreview(null)}>Choose another file</button>
            <button type="submit" disabled={!mapping.name || run.isPending}>{run.isPending ? "Importing…" : `Import ${preview.rows} row${preview.rows === 1 ? "" : "s"}`}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
