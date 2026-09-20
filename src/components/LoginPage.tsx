import { FormEvent, useState } from "react";
import { api } from "../lib/api";

interface Props {
  canRegister: boolean;
  onDone: () => void;
}

export function LoginPage({ canRegister, onDone }: Props) {
  const [creating, setCreating] = useState(canRegister);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (creating) await api.register(email, displayName || "Owner", password);
      else await api.login(email, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>Wealth Portfolio Tracker</h1>
        <p className="muted" style={{ marginBottom: "1.25rem" }}>
          {creating
            ? "Create the owner account. This works once; after that, registration is closed."
            : "Sign in to see your wealth."}
        </p>
        {error && <p className="notice error">{error}</p>}
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {creating && (
            <label className="field">
              <span>Display name</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
            </label>
          )}
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={creating ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {creating && <span>At least 10 characters, with upper case, lower case and a number.</span>}
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Please wait…" : creating ? "Create account" : "Sign in"}
          </button>
        </form>
        {canRegister && (
          <p className="muted" style={{ marginTop: "1rem" }}>
            {creating ? "Already have the account? " : "First time here? "}
            <button className="linkish" type="button" onClick={() => setCreating(!creating)}>
              {creating ? "Sign in" : "Create the owner account"}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
