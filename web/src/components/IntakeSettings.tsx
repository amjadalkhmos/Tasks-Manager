import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, RefreshCw } from "lucide-react";
import { api } from "../api";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label>
      {label}
      <span className="copy-row">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy size={14} /> {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}

/** Where customers send tickets from: a public form and an email address, each behind a secret link that can be changed. */
export function IntakeSettings({ projectId, intake, onChanged }: { projectId: number; intake: { enabled: boolean; token: string | null }; onChanged: () => void }) {
  const set = useMutation({ mutationFn: (v: { enabled: boolean; rotate?: boolean }) => api.setIntake(projectId, v.enabled, v.rotate), onSuccess: onChanged });
  const origin = window.location.origin;
  return (
    <div className="settings-form">
      <p className="muted small">
        Customers don't need an account. Turn this on to get a link to a public form and an address your mail system can forward to. Anyone who has the link can
        send tickets, so keep it to your customers; you can change it at any time, which stops the old one working.
      </p>
      {!intake.enabled ? (
        <div><button type="button" disabled={set.isPending} onClick={() => set.mutate({ enabled: true })}>Turn on customer intake</button></div>
      ) : (
        <>
          <CopyField label="Public support form" value={`${origin}/support/${intake.token}`} />
          <CopyField label="Email intake address (webhook)" value={`${origin}/api/intake/email/${intake.token}`} />
          <details className="muted small">
            <summary>How to receive tickets by email</summary>
            <p>
              Ask your email provider to forward messages sent to your support address to the webhook above (an "inbound" or "routing" feature, for example
              Postmark, Mailgun, SendGrid or Cloudflare Email Routing). Each message becomes a ticket, and a reply that keeps “[#123]” in its subject is
              added to ticket 123 from the same sender. Automatic bounces and empty messages are ignored.
            </p>
            <p>The app doesn't send email. Reply to customers from your own mailbox, and use “Mark first response” on the ticket to stop its reply clock.</p>
          </details>
          <div className="row-inline">
            <button type="button" className="secondary" disabled={set.isPending} onClick={() => confirm("Change the link? The current form and email address stop working immediately.") && set.mutate({ enabled: true, rotate: true })}>
              <RefreshCw size={14} /> Create a new link
            </button>
            <button type="button" className="ghost danger-text" disabled={set.isPending} onClick={() => set.mutate({ enabled: false })}>Turn off</button>
          </div>
        </>
      )}
      {set.error && <p className="alert" role="alert">{set.error.message}</p>}
    </div>
  );
}
