import { useCallback, useEffect, useState } from "react";
import { request } from "../api/core";
interface Worker {
  id: string;
  label: string;
  state: string;
  workspaceRoot: string;
  runtimeTypes: string[];
  projectIds: string[];
  maxConcurrent: number;
  activeLeases: number;
  lastSeenAt: number | null;
  credentialExpiresAt: number | null;
}
interface Enrollment {
  worker: Worker;
  enrollment: { token: string; expiresAt: number };
}
export function FleetPanel({
  projects,
  canManage = true,
  refreshKey,
}: {
  projects: Array<{ id: string; title: string }>;
  canManage?: boolean;
  refreshKey?: number;
}) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [label, setLabel] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [runtime, setRuntime] = useState("codex");
  const [projectId, setProjectId] = useState("");
  const [capacity, setCapacity] = useState(1);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const data = await request<{ workers: Worker[] }>("/api/crew/fleet/workers");
      setWorkers(data.workers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runner konnten nicht geladen werden");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Runner-Änderung fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ic-form" aria-label="Native Runner-Flotte">
      <p>
        Runner verbinden sich ausgehend per TLS. Projektordner und Runtime sind fest zugewiesen. CLI-Anmeldungen bleiben
        beim Runner-Benutzer.
      </p>
      {error && <p role="alert">{error}</p>}
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void mutate(async () =>
              setEnrollment(
                await request<Enrollment>("/api/crew/fleet/enrollments", {
                  method: "POST",
                  body: JSON.stringify({
                    label,
                    workspaceRoot: workspace,
                    runtimeTypes: [runtime],
                    projectIds: [projectId],
                    allowUnscoped: false,
                    maxConcurrent: capacity,
                    ttlSeconds: 600,
                  }),
                }),
              ),
            );
          }}
        >
          <label>
            Runner-Name
            <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} />
          </label>
          <label>
            Workspace auf dem Runner
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              required
              placeholder="/srv/ironcrew/projekte"
            />
          </label>
          <label>
            Projekt
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              <option value="">Projekt auswählen</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Runtime
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)}>
              {["claude", "codex", "antigravity", "openrouter"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Parallele Runs
            <input
              type="number"
              min={1}
              max={8}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
            />
          </label>
          <button className="ic-btn" disabled={busy || !projectId}>
            Einmalige Anmeldung erstellen
          </button>
        </form>
      )}
      {enrollment && (
        <div role="status">
          <h3>Anmeldung für {enrollment.worker.label}</h3>
          <p>
            Einmaliger Token, gültig bis {new Date(enrollment.enrollment.expiresAt).toLocaleString("de-DE")}. Im lokalen
            Runner-Setup verwenden. Er wird hier nur bis zum Schließen angezeigt.
          </p>
          <code style={{ overflowWrap: "anywhere" }}>{enrollment.enrollment.token}</code>
          <p>Setup: docs/RUNNER_FLEET.md</p>
          <button className="ic-btn" onClick={() => setEnrollment(null)}>
            Token ausblenden
          </button>
        </div>
      )}
      <ul className="ic-milestone-list">
        {workers.map((worker) => (
          <li key={worker.id}>
            <strong>{worker.label}</strong>
            <span>
              {worker.state} · {worker.activeLeases}/{worker.maxConcurrent} Runs · {worker.runtimeTypes.join(", ")}
            </span>
            <code>{worker.workspaceRoot}</code>
            <span>
              Letztes Signal: {worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString("de-DE") : "noch keines"}
            </span>
            {canManage && worker.state !== "revoked" && (
              <button
                className="ic-btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Runner „${worker.label}“ widerrufen und aktive Runs abbrechen?`))
                    void mutate(async () => {
                      await request(`/api/crew/fleet/workers/${encodeURIComponent(worker.id)}/revoke`, {
                        method: "POST",
                        body: "{}",
                      });
                    });
                }}
              >
                Zugriff widerrufen
              </button>
            )}
          </li>
        ))}
      </ul>
      {!workers.length && <p>Noch kein Runner angemeldet.</p>}
    </section>
  );
}
