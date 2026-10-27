import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DuplicateError, salesApi } from "../../api";
import { useRefreshSales, useSales } from "../../lib/sales";
import { Dialog, DuplicateNotice, ErrorLine, OwnerSelect } from "./bits";

const defaultOwner = (me: ReturnType<typeof useSales>["me"]): number | null =>
  me.assignable.owners.some((o) => o.id === me.user_id) ? me.user_id : (me.assignable.owners[0]?.id ?? null);

export function NewAccountDialog({ onClose }: { onClose: () => void }) {
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const [f, setF] = useState({ name: "", website: "", industry: "", size: "", phone: "" });
  const [owner, setOwner] = useState<number | null>(defaultOwner(me));
  const [dup, setDup] = useState<DuplicateError | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const save = useMutation({
    mutationFn: (force: boolean) => salesApi.createAccount({ workspace_id: wid, ...f, name: f.name.trim(), owner_id: owner, ...(force ? { allow_duplicate: true } : {}) }),
    onError: (e) => setDup(e instanceof DuplicateError ? e : null),
    onSuccess: async (a) => {
      await refresh();
      onClose();
      navigate(`/sales/${wid}/accounts/${a.id}`);
    },
  });
  return (
    <Dialog title="New account" onClose={onClose}>
      <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), setDup(null), f.name.trim() && save.mutate(false))}>
        <label>Company<input autoFocus required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="two">
          <label>Website<input maxLength={200} placeholder="example.com" value={f.website} onChange={(e) => set({ website: e.target.value })} /></label>
          <label>Industry<input maxLength={100} value={f.industry} onChange={(e) => set({ industry: e.target.value })} /></label>
        </div>
        <div className="two">
          <label>Size<input maxLength={50} placeholder="e.g. 50-200" value={f.size} onChange={(e) => set({ size: e.target.value })} /></label>
          <label>Phone<input maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
        </div>
        <OwnerSelect me={me} value={owner} onChange={setOwner} />
        {dup && <DuplicateNotice dup={dup} busy={save.isPending} onForce={() => save.mutate(true)} />}
        <ErrorLine error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!f.name.trim() || save.isPending}>Add account</button>
        </div>
      </form>
    </Dialog>
  );
}

export function NewContactDialog({ accountId, onClose }: { accountId?: number; onClose: () => void }) {
  const { workspaceId: wid, me } = useSales();
  const navigate = useNavigate();
  const refresh = useRefreshSales();
  const accounts = useQuery({ queryKey: ["sales", "accounts", wid, "all"], queryFn: () => salesApi.accounts(wid), enabled: accountId === undefined });
  const [f, setF] = useState({ name: "", email: "", phone: "", job_title: "" });
  const [account, setAccount] = useState(accountId ? String(accountId) : "");
  const [owner, setOwner] = useState<number | null>(defaultOwner(me));
  const [dup, setDup] = useState<DuplicateError | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const save = useMutation({
    mutationFn: (force: boolean) =>
      salesApi.createContact({ workspace_id: wid, ...f, name: f.name.trim(), email: f.email.trim(), ...(account ? { account_id: Number(account) } : { owner_id: owner }), ...(force ? { allow_duplicate: true } : {}) }),
    onError: (e) => setDup(e instanceof DuplicateError ? e : null),
    onSuccess: async (c) => {
      await refresh();
      onClose();
      if (accountId === undefined) navigate(`/sales/${wid}/contacts/${c.id}`);
    },
  });
  return (
    <Dialog title="New contact" onClose={onClose}>
      <form className="settings-form" style={{ maxWidth: "none" }} onSubmit={(e) => (e.preventDefault(), setDup(null), f.name.trim() && save.mutate(false))}>
        <div className="two">
          <label>Name<input autoFocus required maxLength={200} value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label>Email<input type="email" maxLength={200} value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
        </div>
        <div className="two">
          <label>Phone<input maxLength={50} value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
          <label>Job title<input maxLength={100} value={f.job_title} onChange={(e) => set({ job_title: e.target.value })} /></label>
        </div>
        {accountId === undefined && (
          <div className="two">
            <label>
              Account
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">None</option>
                {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            {!account && <OwnerSelect me={me} value={owner} onChange={setOwner} />}
          </div>
        )}
        {account && <p className="muted small">The contact belongs to the same owner as its account.</p>}
        {dup && <DuplicateNotice dup={dup} busy={save.isPending} onForce={() => save.mutate(true)} />}
        <ErrorLine error={save.error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!f.name.trim() || save.isPending}>Add contact</button>
        </div>
      </form>
    </Dialog>
  );
}
