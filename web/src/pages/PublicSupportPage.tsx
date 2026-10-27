import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleCheck, LifeBuoy } from "lucide-react";
import { api } from "../api";

/** The page a customer sees: a short form, no account needed. Reachable only through the desk's secret link. */
export function PublicSupportPage() {
  const token = useParams().token ?? "";
  const desk = useQuery({ queryKey: ["public-desk", token], queryFn: () => api.publicDesk(token), retry: false });
  const [f, setF] = useState({ name: "", email: "", subject: "", message: "", website: "" });
  const send = useMutation({ mutationFn: () => api.publicTicket(token, f) });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };

  if (desk.isLoading) return <p className="center" role="status">Loading…</p>;
  if (!desk.data) {
    return (
      <main className="public-wrap">
        <div className="public-card">
          <h1>This support page isn't available</h1>
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
            <h1>Thanks, we have your request</h1>
            {send.data.ticket_no !== null && <p>Your reference is <strong>#{send.data.ticket_no}</strong>. Keep “[#{send.data.ticket_no}]” in the subject if you reply by email.</p>}
            <p className="muted">The {desk.data.name} team will get back to you at {f.email}.</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="auth-form" style={{ maxWidth: "none" }}>
            <div className="public-brand"><LifeBuoy size={20} /> {desk.data.name}</div>
            <h1>How can we help?</h1>
            <label>Your name<input required maxLength={100} autoComplete="name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
            <label>Your email<input required type="email" maxLength={200} autoComplete="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
            <label>Subject<input required maxLength={200} value={f.subject} onChange={(e) => set({ subject: e.target.value })} /></label>
            <label>
              What's happening?
              <textarea required rows={6} maxLength={5000} value={f.message} onChange={(e) => set({ message: e.target.value })} />
            </label>
            {/* Real visitors never see this; a bot that fills in every field gives itself away. */}
            <div className="hp" aria-hidden="true">
              <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set({ website: e.target.value })} /></label>
            </div>
            {send.error && <p className="alert" role="alert">{send.error.message}</p>}
            <button type="submit" disabled={send.isPending}>{send.isPending ? "Sending…" : "Send request"}</button>
          </form>
        )}
      </div>
    </main>
  );
}
