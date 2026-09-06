import { useGovernanceI18n } from "./governance-i18n";
/**
 * Your own account, and — for an owner — everyone else's.
 *
 * Two audiences in one panel, deliberately: the things a person does here are
 * rare (change a password, end a forgotten session, add a colleague), and
 * three separate screens for three rare actions is how a setting ends up
 * never being found.
 *
 * What an owner sees is decided by the server, not by hiding buttons: a
 * non-owner asking for the user list gets a 403, and this panel simply does
 * not ask. Hiding a control is a courtesy; the refusal is the control.
 */

import { useCallback, useEffect, useState } from "react";
import { api, serverMessage } from "./api";
import type { CrewSession, CrewUser } from "./types";

interface AccountPanelProps {
  user: CrewUser;
  onClose(): void;
  client?: Pick<
    typeof api,
    "ownSessions" | "revokeOwnSession" | "changeOwnPassword" | "users" | "createUser" | "updateUser" | "setUserPassword"
  >;
}

const ROLES: Array<{ value: CrewUser["role"]; label: string; hint: string }> = [
  { value: "viewer", label: "Leser", hint: "darf lesen" },
  { value: "operator", label: "Operator", hint: "führt die Firma" },
  { value: "owner", label: "Inhaber", hint: "entscheidet Freigaben" },
];

function when(ts: number | null, locale: string): string {
  return ts ? new Date(ts).toLocaleString(locale) : "—";
}

export function AccountPanel({ user, onClose, client = api }: AccountPanelProps): React.JSX.Element {
  const { tx, locale } = useGovernanceI18n();
  const [sessions, setSessions] = useState<CrewSession[]>([]);
  const [users, setUsers] = useState<CrewUser[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<CrewUser["role"]>("operator");
  const [newUserPassword, setNewUserPassword] = useState("");

  const isOwner = user.role === "owner";

  const load = useCallback(async () => {
    try {
      setSessions((await client.ownSessions()).sessions);
      if (isOwner) setUsers((await client.users()).users);
    } catch (err) {
      setError(serverMessage(err));
    }
  }, [client, isOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(done);
      await load();
    } catch (err) {
      setError(serverMessage(err));
    }
  };

  return (
    <div className="ic-modal" role="dialog" aria-label={tx("Konto")}>
      <div className="ic-modal-body ic-account-panel">
        <header>
          <h2>{tx("Konto")}</h2>
          <button type="button" onClick={onClose} aria-label={tx("Schließen")}>
            ×
          </button>
        </header>

        {error && <p className="ic-identity-error">{error}</p>}
        {message && <p className="ic-identity-ok">{message}</p>}

        <section>
          <h3>{tx("Passwort ändern")}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await client.changeOwnPassword(currentPassword, newPassword);
                setCurrentPassword("");
                setNewPassword("");
              }, tx("Passwort geändert. Andere Sitzungen wurden beendet."));
            }}
            className="ic-identity-form"
          >
            <label>
              {tx("Aktuelles Passwort")}{" "}
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              {tx("Neues Passwort")}{" "}
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </label>
            <button type="submit">{tx("Ändern")}</button>
          </form>
        </section>

        <section>
          <h3>{tx("Angemeldete Geräte")}</h3>
          <table>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.current ? tx("dieses Gerät") : session.ip || tx("unbekannt")}</td>
                  <td title={session.userAgent}>{when(session.lastSeenAt ?? session.createdAt, locale)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void act(() => client.revokeOwnSession(session.id), tx("Sitzung beendet."))}
                    >
                      {session.current ? tx("Abmelden") : tx("Beenden")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {isOwner && (
          <section>
            <h3>{tx("Benutzer")}</h3>
            <table>
              <tbody>
                {users.map((other) => (
                  <tr key={other.id} data-status={other.status}>
                    <td>
                      {other.displayName || other.email}
                      <br />
                      <small>{other.email}</small>
                    </td>
                    <td>
                      <select
                        value={other.role}
                        onChange={(e) =>
                          void act(
                            () => client.updateUser(other.id, { role: e.target.value as CrewUser["role"] }),
                            tx("Rolle geändert."),
                          )
                        }
                      >
                        {ROLES.map((role) => (
                          <option key={role.value} value={role.value}>
                            {tx(role.label)} — {tx(role.hint)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{other.status === "active" ? when(other.lastLoginAt, locale) : tx("gesperrt")}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          void act(
                            () =>
                              client.updateUser(other.id, {
                                status: other.status === "active" ? "disabled" : "active",
                              }),
                            other.status === "active" ? tx("Konto gesperrt.") : tx("Konto entsperrt."),
                          )
                        }
                      >
                        {other.status === "active" ? tx("Sperren") : tx("Entsperren")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>{tx("Neuen Benutzer anlegen")}</h4>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await client.createUser({
                    email: newEmail.trim(),
                    password: newUserPassword,
                    displayName: newName.trim() || undefined,
                    role: newRole,
                  });
                  setNewEmail("");
                  setNewName("");
                  setNewUserPassword("");
                }, tx("Benutzer angelegt."));
              }}
              className="ic-identity-form"
            >
              <label>
                {tx("E-Mail")}{" "}
                <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
              </label>
              <label>
                Name
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
              <label>
                {tx("Rolle")}{" "}
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as CrewUser["role"])}>
                  {ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {tx(role.label)} — {tx(role.hint)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {tx("Passwort")}{" "}
                <input
                  type="password"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </label>
              <button type="submit">{tx("Anlegen")}</button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
