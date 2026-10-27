import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, MessageSquareText } from "lucide-react";
import { salesApi } from "../api";

/** The page a prospect sees: a short form, no account needed. Reachable only through the form's secret link. */
export function PublicLeadPage() {
  const token = useParams().token ?? "";
  const form = useQuery({ queryKey: ["public-lead-form", token], queryFn: () => salesApi.publicForm(token), retry: false });
  const [f, setF] = useState({ name: "", email: "", phone: "", company: "", message: "", website: "" });
  const send = useMutation({ mutationFn: () => salesApi.publicInquiry(token, f) });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };

  if (form.isLoading) return <p className="center" role="status">Loading…</p>;
  if (!form.data) {
    return (
      <main className="public-wrap">
        <div className="public-card">
          <h1>This form isn't available</h1>
          <p className="muted">The link may be wrong, or the team has closed this form. Please contact them another way.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="public-wrap">
      <div className="public-card">
        {send.isSuccess ? (
          <div className="public-done" role="status">
            <CircleCheck size={36} />
            <h1>Thanks, we'll be in touch</h1>
            <p className="muted">The {form.data.workspace} team has your details and will write to you at {f.email}.</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="auth-form" style={{ maxWidth: "none" }}>
            <div className="public-brand"><MessageSquareText size={20} /> {form.data.workspace}</div>
            <h1>Get in touch</h1>
            <label>Your name<input required maxLength={100} autoComplete="name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label>Your email<input required type="email" maxLength={200} autoComplete="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
            <label>Company<input maxLength={200} autoComplete="organization" value={f.company} onChange={(e) => set({ company: e.target.value })} /></label>
            <label>Phone<input type="tel" maxLength={50} autoComplete="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
            <label>
              How can we help?
              <textarea rows={5} maxLength={5000} value={f.message} onChange={(e) => set({ message: e.target.value })} />
            </label>
            {/* Real visitors never see this; a bot that fills in every field gives itself away. */}
            <div className="hp" aria-hidden="true">
              <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set({ website: e.target.value })} /></label>
            </div>
            {send.error && <p className="alert" role="alert">{send.error.message}</p>}
            <button type="submit" disabled={send.isPending}>{send.isPending ? "Sending…" : "Send"}</button>
          </form>
        )}
      </div>
    </main>
  );
}
