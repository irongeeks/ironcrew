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

/**
 * What each refusal code means to the person looking at the screen.
 *
 * Deliberately not a mirror of the provider's twenty codes. Somebody at a
 * login form can act on three things: retry, check the clock, or ask an owner
 * to link their account. Every code that means "the token was wrong in some
 * way" therefore lands on the same sentence — the distinction between a bad
 * audience and a bad signature is an operator's question, and the log has it
 * in full. Anything not listed gets the generic line rather than a raw code.
 */
const SSO_ERROR_LABEL: Record<string, string> = {
  provider_unreachable: "Das Verzeichnis war nicht erreichbar. Melde dich mit E-Mail und Passwort an.",
  provider_refused: "Das Verzeichnis hat die Anmeldung abgelehnt.",
  no_login_in_progress: "Diese Anmeldung ist abgelaufen oder wurde schon verwendet. Bitte neu starten.",
  login_expired: "Diese Anmeldung ist abgelaufen. Bitte neu starten.",
  // The one refusal an owner can actually fix, so it says what to do.
  subject_not_linked:
    "Dieses Verzeichnis-Konto ist mit keinem IronCrew-Konto verknüpft. Ein Inhaber muss es zuerst verknüpfen.",
  account_unavailable: "Das zugehörige IronCrew-Konto ist deaktiviert.",
};

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
  /**
   * What the directory login came back with, if it failed.
   *
   * The callback redirects to `/?oidc_error=<code>` rather than rendering a
   * message: the person is mid-navigation at that point and there is no React
   * app to hand an error to. Only a code from a fixed vocabulary travels — the
   * full reason names the issuer and the subject, which do not belong in a
   * browser's history.
   */
  const [ssoError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const code = new URLSearchParams(window.location.search).get("oidc_error");
    if (!code) return null;
    // Cleared from the address bar so a refresh does not re-show it, and so
    // the code is not carried into a bookmark.
    window.history.replaceState({}, "", window.location.pathname);
    return code;
  });

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
          {ssoError && (
            <p className="ic-identity-error" data-testid="oidc-error">
              {SSO_ERROR_LABEL[ssoError] ?? "Die Anmeldung über das Verzeichnis ist fehlgeschlagen."}
            </p>
          )}

          {status?.oidc?.configured && (
            // A plain link, not a fetch: the whole point of the flow is a
            // top-level navigation to the identity provider and back, and an
            // XHR cannot carry the person through a password prompt and a
            // second factor at somebody else's origin.
            //
            // Shown only when the server says a directory is configured. The
            // password form stays above it either way — the day the directory
            // is down is exactly the day somebody has to sign in and fix it.
            <p className="ic-identity-alt">
              <a className="ic-identity-sso" href="/api/crew/auth/oidc/start" data-testid="oidc-start">
                Mit dem Verzeichnis anmelden
              </a>
              {status.oidc.issuer && (
                // Named, because an operator has to be able to see *which*
                // directory this box trusts before they hand it a password.
                <span className="ic-identity-issuer"> ({status.oidc.issuer})</span>
              )}
            </p>
          )}
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
