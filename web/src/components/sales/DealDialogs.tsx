import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DuplicateError, salesApi } from "../../api";
import { useRefreshSales, useSales } from "../../lib/sales";
import { Dialog, DuplicateNotice, ErrorLine, OwnerSelect } from "./bits";

/** Starting a deal: whose account it is for, where it sits in the pipeline, what it is worth and when it should close. */
export function NewDealDialog({ accountId, pipelineId, onClose }: { accountId?: number; pipelineId?: number; onClose: () => void }) {
  const { workspaceId: wid, me, pipelines } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const accounts = useQuery({ queryKey: ["sales", "accounts", wid, "all"], queryFn: () => salesApi.accounts(wid) });

  const [title, setTitle] = useState("");
  const [account, setAccount] = useState<string>(accountId ? String(accountId) : "");
  const [newName, setNewName] = useState("");
  const [pipeline, setPipeline] = useState(pipelineId ?? pipelines[0]?.id ?? 0);
  const [stage, setStage] = useState<number | "">("");
  const [value, setValue] = useState("");
  const [close, setClose] = useState("");
  const [owner, setOwner] = useState<number | null>(me.assignable.owners.some((o) => o.id === me.user_id) ? me.user_id : (me.assignable.owners[0]?.id ?? null));
  const [contact, setContact] = useState("");
  const [dup, setDup] = useState<DuplicateError | null>(null);

  const contacts = useQuery({
    queryKey: ["sales", "contacts", wid, { account }],
    queryFn: () => salesApi.contacts(wid, { account_id: Number(account) }),
    enabled: !!account && account !== "new",
  });
  const chosen = pipelines.find((p) => p.id === pipeline);
  const openStages = (chosen?.stages ?? []).filter((s) => s.kind === "open");

  const save = useMutation({
    mutationFn: async (force: boolean) => {
      let accountIdToUse = Number(account);
      if (account === "new") accountIdToUse = (await salesApi.createAccount({ workspace_id: wid, name: newName.trim(), owner_id: owner, ...(force ? { allow_duplicate: true } : {}) })).id;
      return salesApi.createDeal({
        workspace_id: wid, title: title.trim(), account_id: accountIdToUse, pipeline_id: pipeline, owner_id: owner,
        ...(stage !== "" ? { stage_id: stage } : {}), ...(value ? { value: Number(value) } : {}), ...(close ? { expected_close: close } : {}), ...(contact ? { contact_id: Number(contact) } : {}),
      });
    },
    onError: (e) => setDup(e instanceof DuplicateError ? e : null),
    onSuccess: async (d) => {
      await refresh();
      onClose();
      navigate(`/sales/${wid}/deals/${d.id}`);
    },
  });

  const ready = title.trim() && (account === "new" ? newName.trim() : account) && pipeline;
  return (
    <Dialog title="New deal" onClose={onClose}>
      <form
        className="settings-form"
        style={{ maxWidth: "none" }}
        onSubmit={(e) => {
          e.preventDefault();
          setDup(null);
          if (ready) save.mutate(false);
        }}
      >
        <label>Deal<input autoFocus required maxLength={200} placeholder="e.g. Annual licence renewal" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {accountId === undefined && (
          <div className="two">
            <label>
              Account
              <select value={account} onChange={(e) => { setAccount(e.target.value); setContact(""); }} required>
                <option value="" disabled>Choose an account…</option>
                {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="new">+ A new account…</option>
              </select>
            </label>
            {account === "new" && <label>New account name<input required maxLength={200} value={newName} onChange={(e) => setNewName(e.target.value)} /></label>}
          </div>
        )}
        {!!account && account !== "new" && (contacts.data?.length ?? 0) > 0 && (
          <label>
            Contact
            <select value={contact} onChange={(e) => setContact(e.target.value)}>
              <option value="">No one in particular</option>
              {contacts.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="two">
          <label>
            Pipeline
            <select value={pipeline} onChange={(e) => { setPipeline(Number(e.target.value)); setStage(""); }}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            Stage
            <select value={stage} onChange={(e) => setStage(e.target.value ? Number(e.target.value) : "")}>
              <option value="">{openStages[0]?.name ?? "First stage"} (start)</option>
              {openStages.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <div className="two">
          <label>Value ({chosen?.currency})<input type="number" min={0} step="any" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <label>Expected close<input type="date" value={close} onChange={(e) => setClose(e.target.value)} /></label>
        </div>
        <OwnerSelect me={me} value={owner} onChange={setOwner} />
        {dup && <DuplicateNotice dup={dup} busy={save.isPending} onForce={() => save.mutate(true)} />}
        <ErrorLine error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!ready || save.isPending || owner === null}>Create deal</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Closing a deal as lost: say why, so the pipeline's losses mean something later. */
export function LostDialog({ title, onConfirm, onClose, busy, error }: { title: string; onConfirm: (reason: string) => void; onClose: () => void; busy?: boolean; error?: Error | null }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog title="Mark as lost" onClose={onClose}>
      <form
        className="settings-form"
        style={{ maxWidth: "none" }}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(reason.trim());
        }}
      >
        <p className="muted">Why was “{title}” lost?</p>
        <label>
          Reason
          <input autoFocus list="lost-reasons" maxLength={200} placeholder="e.g. Went with a competitor" value={reason} onChange={(e) => setReason(e.target.value)} />
          <datalist id="lost-reasons">
            {["Price", "Went with a competitor", "No budget", "No decision", "Bad timing", "Not a fit"].map((r) => <option key={r} value={r} />)}
          </datalist>
        </label>
        <ErrorLine error={error ?? null} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>Mark as lost</button>
        </div>
      </form>
    </Dialog>
  );
}
