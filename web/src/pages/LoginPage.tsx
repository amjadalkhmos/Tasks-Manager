import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "../api";

export function LoginPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = useMutation({
    mutationFn: () => (mode === "login" ? api.login(email, password) : api.register(email, password, name.trim() || undefined)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const isLogin = mode === "login";

  return (
    <div className="auth-wrap">
      <aside className="auth-aside" aria-hidden="true">
        <div className="brand"><span className="brand-mark"><Check size={14} strokeWidth={3} /></span>Tasks</div>
        <div>
          <h2>Plan the day. Keep the week honest.</h2>
          <p>Capture in one line, schedule with plain words, and let recurring work take care of itself.</p>
        </div>
        <div className="auth-sample">
          <div><span className="ring on" /><span className="on-text">Send invoice to Dana</span></div>
          <div><span className="ring" />Call Sam tomorrow 3pm<small>High</small></div>
          <div><span className="ring" />Water plants<small>Every week</small></div>
        </div>
      </aside>

      <main className="auth-main">
        <form className="auth-form" onSubmit={onSubmit}>
          <h1>{isLogin ? "Welcome back" : "Create your account"}</h1>
          {!isLogin && (
            <label>
              Your name <span className="muted" style={{ fontWeight: 400 }}>(shown to teammates)</span>
              <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isLogin ? "current-password" : "new-password"}
              aria-describedby={isLogin ? undefined : "pw-hint"}
            />
            {!isLogin && <span id="pw-hint" className="muted small" style={{ fontWeight: 400 }}>At least 8 characters.</span>}
          </label>
          {submit.error && <p className="alert" role="alert">{submit.error.message}</p>}
          <button type="submit" disabled={submit.isPending}>
            {submit.isPending ? "Please wait…" : isLogin ? "Sign in" : "Create account"}
          </button>
          <p className="switch">
            {isLogin ? "New here? " : "Already have an account? "}
            <button type="button" className="link" onClick={() => (setMode(isLogin ? "register" : "login"), submit.reset())}>
              {isLogin ? "Create an account" : "Sign in"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
