/**
 * The front door of the Command Center.
 *
 * Three states, decided by the server rather than guessed here:
 *
 *   bootstrap      no account exists — offer to create the first owner
 *   signed out     accounts exist — ask for one
 *   signed in      render the Command Center, plus who you are
 *
 * The bootstrap state is what keeps an existing installation working: before
 * anyone creates an account, the shared password is still the only credential
 * and nothing about the app changes (server/ironcrew/auth/crew-auth.ts).
 *
 * The gate deliberately wraps the Command Center instead of living inside it.
 * The view is five thousand lines that know nothing about identity, and it
 * should stay that way: everything here is about who is asking, nothing about
 * what the company is doing.
 */

import { useCallback, useEffect, useState } from "react";
import { api, serverMessage } from "./api";
import { AccountPanel } from "./AccountPanel";
import { PacksPanel } from "./PacksPanel";
import type { AuthStatus, CrewUser } from "./types";

interface IdentityGateProps {
  children: React.ReactNode;
  client?: Pick<typeof api, "authStatus" | "login" | "logout" | "createUser">;
}

const ROLE_LABEL: Record<CrewUser["role"], string> = {
  owner: "Inhaber",
  operator: "Operator",
  viewer: "Leser",
};

export function IdentityGate({ children, client = api }: IdentityGateProps): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);
  const [showPacks, setShowPacks] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await client.authStatus());
    } catch (err) {
      // A gate that cannot ask must not lock the operator out of their own
      // installation: report, and let the app render as it did before.
      setError(serverMessage(err));
      setStatus({ bootstrap: true, authenticated: false, user: null });
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.login(email.trim(), password);
      setPassword("");
      await refresh();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitFirstOwner = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createUser({ email: email.trim(), password, displayName: displayName.trim() || undefined });
      // Straight into a session, so the first owner is not immediately locked
      // out of the surface their own account just closed.
      await client.login(email.trim(), password);
      setPassword("");
      await refresh();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await client.logout();
      await refresh();
    } catch (err) {
      setError(serverMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="ic-identity-gate" data-state="loading">
        <p>Anmeldung wird geprüft …</p>
      </div>
    );
  }

  // Nobody has an account yet: the installation runs as it always did, and
  // the offer to create the first owner is an invitation, not a wall.
  if (status?.bootstrap && !status.authenticated) {
    return (
      <>
        <div className="ic-identity-banner" data-state="bootstrap">
          <span>
            Diese Installation hat noch keine Benutzerkonten. Das Audit-Log schreibt deshalb „ceo" statt eines Namens.
          </span>
          <details>
            <summary>Ersten Inhaber anlegen</summary>
            <form onSubmit={submitFirstOwner} className="ic-identity-form">
              <label>
                E-Mail
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label>
                Name
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </label>
              <label>
                Passwort
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? "Wird angelegt …" : "Inhaber anlegen"}
              </button>
              {error && <p className="ic-identity-error">{error}</p>}
            </form>
          </details>
        </div>
        {children}
      </>
    );
  }

  if (!status?.authenticated) {
    return (
      <div className="ic-identity-gate" data-state="login">
        <form onSubmit={submitLogin} className="ic-identity-form">
          <h2>IronCrew</h2>
          <label>
            E-Mail
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label>
            Passwort
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Anmelden …" : "Anmelden"}
          </button>
          {error && <p className="ic-identity-error">{error}</p>}
        </form>
      </div>
    );
  }

  const user = status.user!;
  return (
    <>
      <div className="ic-identity-banner" data-state="signed-in">
        <span>
          {user.displayName || user.email} · {ROLE_LABEL[user.role]}
        </span>
        <button type="button" onClick={() => setShowPacks(true)}>
          Gewerke
        </button>
        <button type="button" onClick={() => setShowAccounts(true)}>
          Konto
        </button>
        <button type="button" onClick={() => void signOut()} disabled={busy}>
          Abmelden
        </button>
      </div>
      {showAccounts && <AccountPanel user={user} onClose={() => setShowAccounts(false)} />}
      {showPacks && <PacksPanel onClose={() => setShowPacks(false)} />}
      {children}
    </>
  );
}
