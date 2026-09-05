import { useCallback, useEffect, useState } from "react";

export interface SandboxAccessGrant {
  id: string;
  task_id: string | null;
  workspace_path: string | null;
  providers_json: string;
  expires_at: number;
  revoked_at: number | null;
  consumed_run_id: string | null;
  reason: string;
}
export interface SandboxAccessData {
  grants: SandboxAccessGrant[];
  requests: Array<{ id: string; summary: string; impact: string }>;
}
export interface SandboxAccessInput {
  taskId: string;
  provider: "claude" | "codex" | "antigravity";
  durationMs: number;
  reason: string;
}
interface Props {
  tasks: Array<{ id: string; title: string; project_id: string | null }>;
  load(): Promise<SandboxAccessData>;
  request(input: SandboxAccessInput): Promise<unknown>;
  revoke(id: string, reason: string): Promise<unknown>;
  onChanged?(): void;
}
export function SandboxAccessPanel({ tasks, load, request, revoke, onChanged }: Props) {
  const [data, setData] = useState<SandboxAccessData>({ grants: [], requests: [] });
  const [taskId, setTaskId] = useState("");
  const [provider, setProvider] = useState<SandboxAccessInput["provider"]>("codex");
  const [minutes, setMinutes] = useState(15);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      setData(await load());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sandbox-Zugriffe konnten nicht geladen werden.");
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Änderung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cc-panel" aria-labelledby="sandbox-access-heading">
      <h2 id="sandbox-access-heading">Sandbox-Ausnahmen</h2>
      <p>
        CLI-Sicherheitsabfragen nur für eine konkrete Aufgabe, deren Projekt-Workspace und genau einen Run umgehen. Der
        Owner muss die Anfrage in der Freigabe-Inbox genehmigen.
      </p>
      <p>
        Ein Widerruf oder Ablauf beendet den erhöhten Run. Bereits erfolgte Änderungen bleiben bestehen und benötigen
        eine Prüfung.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            () => request({ taskId, provider, durationMs: minutes * 60_000, reason }),
            "Anfrage erstellt. Bitte die konkrete Ausnahme in der Freigabe-Inbox prüfen.",
          );
        }}
      >
        <label>
          Aufgabe
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} required disabled={busy}>
            <option value="">Aufgabe mit Projekt auswählen</option>
            {tasks
              .filter((task) => task.project_id)
              .map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          Runtime
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as SandboxAccessInput["provider"])}
            disabled={busy}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="antigravity">Antigravity</option>
          </select>
        </label>
        <label>
          Zeitfenster in Minuten
          <input
            type="number"
            min={1}
            max={240}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
            required
            disabled={busy}
          />
        </label>
        <label>
          Begründung
          <textarea
            minLength={10}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={busy || !taskId || reason.trim().length < 10}>
          Ausnahme anfragen
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <h3>Offene Anfragen</h3>
      {data.requests.length === 0 ? (
        <p>Keine offenen Sandbox-Anfragen.</p>
      ) : (
        <ul>
          {data.requests.map((item) => (
            <li key={item.id}>
              {item.summary}
              <p>{item.impact}</p>
            </li>
          ))}
        </ul>
      )}
      <h3>Genehmigte Zeitfenster</h3>
      {data.grants.length === 0 ? (
        <p>Noch keine Sandbox-Ausnahme genehmigt.</p>
      ) : (
        <ul>
          {data.grants.map((grant) => (
            <li key={grant.id}>
              <strong>{tasks.find((task) => task.id === grant.task_id)?.title ?? "Aufgabe"}</strong>
              <p>{grant.workspace_path}</p>
              <p>
                {grant.revoked_at
                  ? "Widerrufen"
                  : grant.expires_at <= Date.now()
                    ? "Abgelaufen"
                    : grant.consumed_run_id
                      ? "An einen Run gebunden"
                      : "Für einen Run verfügbar"}{" "}
                · endet {new Date(grant.expires_at).toLocaleString("de-DE")}
              </p>
              {!grant.revoked_at && grant.expires_at > Date.now() && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () => revoke(grant.id, "Vom Owner in der Sandbox-Ansicht widerrufen"),
                      "Sandbox-Ausnahme widerrufen.",
                    )
                  }
                >
                  Widerrufen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Aktualisieren
      </button>
    </section>
  );
}
