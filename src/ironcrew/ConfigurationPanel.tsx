import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/core";
import {
  companyConfigurationSchema,
  type CompanyConfiguration,
  type CompanyConfigurationSnapshot,
} from "../shared/company-configuration";
import { configurationApi } from "./configuration-api";
import "./ConfigurationPanel.css";

const sections = { runtime: "Laufzeiten", approvals: "Freigaben", tools: "Tools", memory: "Memory" } as const;
const riskLabels = { read: "Lesen", write: "Schreiben", external: "Externe Aktion" } as const;
function errorText(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.details && typeof cause.details === "object") {
    const message = (cause.details as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return cause instanceof Error ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden.";
}

export function ConfigurationPanel({
  canManage = false,
  refreshKey = 0,
}: {
  canManage?: boolean;
  refreshKey?: number;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CompanyConfigurationSnapshot | null>(null);
  const [draft, setDraft] = useState<CompanyConfiguration | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [section, setSection] = useState<keyof typeof sections>("runtime");
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const saving = useRef(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);

  const adopt = useCallback((result: CompanyConfigurationSnapshot) => {
    setDraft(structuredClone(result.configuration));
    setBaseRevision(result.revision);
    dirtyRef.current = false;
    setDirty(false);
    setConflict(false);
    setReason("");
  }, []);
  const load = useCallback(async () => {
    if (saving.current) return;
    const token = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await configurationApi.load();
      if (generation.current !== token) return;
      setSnapshot(result);
      if (!dirtyRef.current) adopt(result);
    } catch (cause) {
      if (generation.current === token) setError(errorText(cause));
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, [adopt]);
  const invalidateRequests = useCallback(() => {
    mounted.current = false;
    generation.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return invalidateRequests;
  }, [invalidateRequests]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const editable = canManage && snapshot?.canEdit === true;
  const stale = snapshot !== null && snapshot.revision !== baseRevision;
  const valid = companyConfigurationSchema.safeParse(draft).success;
  function change(update: (current: CompanyConfiguration) => CompanyConfiguration) {
    if (!editable || busy) return;
    setDraft((current) => (current ? update(current) : current));
    dirtyRef.current = true;
    setDirty(true);
    setNotice("");
  }
  async function save() {
    if (!editable || !draft || !valid || !dirty || stale || conflict || saving.current || reason.trim().length < 10)
      return;
    saving.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await configurationApi.save({ baseRevision, reason: reason.trim(), configuration: draft });
      if (!mounted.current) return;
      setSnapshot(result);
      adopt(result);
      setNotice(`Konfiguration gespeichert. Revision ${result.revision} ist aktiv.`);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiRequestError && cause.status === 409) {
        setConflict(true);
        setError(
          "Der Serverstand wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand und vergleiche die Änderungen.",
        );
      } else setError(errorText(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="configuration-panel" aria-label="Firmenkonfiguration" aria-busy={loading || busy}>
      <header>
        <div>
          <h2>Firmenkonfiguration</h2>
          <p>Arbeitsgrenzen, Freigaben und Kontext für deine Crew.</p>
        </div>
        <div className="configuration-actions">
          {snapshot && <span>Revision {snapshot.revision}</span>}
          <button type="button" className="ic-btn" disabled={loading || busy} onClick={() => void load()}>
            Serverstand laden
          </button>
        </div>
      </header>
      {loading && (
        <div className="configuration-loading" role="status">
          Konfiguration wird geladen …<div aria-hidden="true" />
          <div aria-hidden="true" />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status" className="configuration-notice">
          {notice}
        </p>
      )}
      {snapshot && draft && (
        <>
          {!editable && (
            <p className="configuration-note">
              Leseansicht: Nur der bestätigte Owner kann die Firmenkonfiguration ändern.
            </p>
          )}
          <p className="configuration-boundary">
            Die Vendor-Policy und verpflichtende Freigaben bleiben verbindlich. Diese Einstellungen erteilen keine
            zusätzlichen Tool- oder Netzwerkrechte.
          </p>
          <nav className="configuration-nav" aria-label="Konfigurationsbereiche">
            {Object.entries(sections).map(([key, title]) => (
              <button
                type="button"
                key={key}
                aria-pressed={section === key}
                onClick={() => setSection(key as keyof typeof sections)}
              >
                {title}
              </button>
            ))}
          </nav>
          <fieldset className="configuration-fields" disabled={!editable || busy}>
            <legend>{sections[section]} bearbeiten</legend>
            {section === "runtime" && (
              <>
                <p>Firmenweite Obergrenzen. Strengere Grenzen einzelner Runtime-Profile gelten weiterhin.</p>
                <div className="configuration-grid">
                  <label>
                    Maximale parallele Runs
                    <input
                      type="number"
                      min={1}
                      max={64}
                      step={1}
                      value={draft.runtime.maxConcurrentRuns}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          runtime: { ...current.runtime, maxConcurrentRuns: Number(event.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>
                    Maximale Laufzeit (Sekunden)
                    <input
                      type="number"
                      min={1}
                      max={86400}
                      step={1}
                      value={draft.runtime.maxRunTimeoutMs / 1000}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          runtime: { ...current.runtime, maxRunTimeoutMs: Number(event.target.value) * 1000 },
                        }))
                      }
                    />
                  </label>
                </div>
                <p className="configuration-note">
                  Änderungen gelten für folgende Run-Starts. Bereits laufende Prozesse werden dadurch nicht beendet.
                </p>
              </>
            )}
            {section === "approvals" && (
              <>
                <p>
                  Erweitere die Freigabepflicht um zusätzliche Aktionstypen. Die festen Schutzregeln können hier nicht
                  aufgehoben werden.
                </p>
                <div
                  className="configuration-tool-list"
                  role="group"
                  aria-label="Zusätzlich freigabepflichtige Aktionen"
                >
                  {snapshot.toolChoices.length === 0 && <p>Es sind noch keine zusätzlichen Tools registriert.</p>}
                  {snapshot.toolChoices
                    .filter((tool) => !snapshot.constraints.alwaysApprovalRequired.includes(tool.key))
                    .map((tool) => (
                      <label className="configuration-check" key={tool.key}>
                        <input
                          type="checkbox"
                          checked={draft.approvals.additionalRequiredTypes.includes(tool.key)}
                          onChange={(event) =>
                            change((current) => ({
                              ...current,
                              approvals: {
                                additionalRequiredTypes: event.target.checked
                                  ? [...current.approvals.additionalRequiredTypes, tool.key]
                                  : current.approvals.additionalRequiredTypes.filter((key) => key !== tool.key),
                              },
                            }))
                          }
                        />
                        <span>
                          {tool.label}
                          <small>{tool.key}</small>
                        </span>
                      </label>
                    ))}
                </div>
                <details className="configuration-floor">
                  <summary>Immer freigabepflichtig ({snapshot.constraints.alwaysApprovalRequired.length})</summary>
                  <ul>
                    {snapshot.constraints.alwaysApprovalRequired.map((action) => (
                      <li key={action}>
                        <code>{action}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
            {section === "tools" && (
              <>
                <p>Gesperrte Tools bleiben auch dann gesperrt, wenn ein Mitarbeiter sie ansonsten verwenden dürfte.</p>
                <div className="configuration-tool-list" role="group" aria-label="Tools sperren">
                  {snapshot.toolChoices.length === 0 && <p>Es sind noch keine Tools registriert.</p>}
                  {snapshot.toolChoices.map((tool) => (
                    <label className="configuration-check" key={tool.key}>
                      <input
                        type="checkbox"
                        checked={draft.tools.blockedToolKeys.includes(tool.key)}
                        onChange={(event) =>
                          change((current) => ({
                            ...current,
                            tools: {
                              ...current.tools,
                              blockedToolKeys: event.target.checked
                                ? [...current.tools.blockedToolKeys, tool.key]
                                : current.tools.blockedToolKeys.filter((key) => key !== tool.key),
                            },
                          }))
                        }
                      />
                      <span>
                        {tool.label}
                        <small>
                          {tool.key} · {riskLabels[tool.riskClass as keyof typeof riskLabels] ?? tool.riskClass}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <h3>Zusätzliche Freigaben nach Risikoklasse</h3>
                {Object.entries(riskLabels).map(([risk, label]) => (
                  <label className="configuration-check" key={risk}>
                    <input
                      type="checkbox"
                      checked={draft.tools.requireApprovalForRiskClasses.includes(risk as keyof typeof riskLabels)}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          tools: {
                            ...current.tools,
                            requireApprovalForRiskClasses: event.target.checked
                              ? [...current.tools.requireApprovalForRiskClasses, risk as keyof typeof riskLabels]
                              : current.tools.requireApprovalForRiskClasses.filter((entry) => entry !== risk),
                          },
                        }))
                      }
                    />
                    Freigabe für {label}
                  </label>
                ))}
              </>
            )}
            {section === "memory" && (
              <>
                <p>
                  Steuere den Kontextabruf für kommende Runs. Gespeichertes Wissen wird beim Ausschalten nicht gelöscht.
                </p>
                <label className="configuration-check">
                  <input
                    type="checkbox"
                    checked={draft.memory.runContextEnabled}
                    onChange={(event) =>
                      change((current) => ({
                        ...current,
                        memory: { ...current.memory, runContextEnabled: event.target.checked },
                      }))
                    }
                  />
                  Memory-Kontext für Runs verwenden
                </label>
                <label>
                  Maximale Kontext-Einträge
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={draft.memory.maxContextEntries}
                    onChange={(event) =>
                      change((current) => ({
                        ...current,
                        memory: { ...current.memory, maxContextEntries: Number(event.target.value) },
                      }))
                    }
                  />
                </label>
                <label className="configuration-check">
                  <input
                    type="checkbox"
                    checked={draft.memory.semanticSearchEnabled}
                    onChange={(event) =>
                      change((current) => ({
                        ...current,
                        memory: { ...current.memory, semanticSearchEnabled: event.target.checked },
                      }))
                    }
                  />
                  Optionale semantische Suche verwenden
                </label>
                <p className="configuration-note">
                  Externe Memory-Dienste müssen zusätzlich eingerichtet sein. Diese Auswahl richtet keinen Dienst ein
                  und überträgt keine Zugangsdaten.
                </p>
              </>
            )}
          </fieldset>
          {!valid && (
            <p role="alert">
              Prüfe die Eingaben: parallele Runs 1–64, Laufzeit 1–86.400 Sekunden, Kontext-Einträge 1–30 und gültige,
              eindeutige Aktionstypen.
            </p>
          )}
          {stale && (
            <section aria-label="Geladener Serverstand">
              <p role="alert">
                Dein Entwurf basiert auf Revision {baseRevision}; geladen ist Revision {snapshot.revision}. Vergleiche
                die Werte vor dem erneuten Speichern.
              </p>
              <details>
                <summary>Aktuelle Serverwerte vergleichen</summary>
                <pre>{JSON.stringify(snapshot.configuration, null, 2)}</pre>
              </details>
            </section>
          )}
          {editable && (conflict || stale) && (
            <div className="configuration-actions">
              {stale && (
                <button
                  type="button"
                  className="ic-btn"
                  disabled={loading || busy || !valid}
                  onClick={() => {
                    setBaseRevision(snapshot.revision);
                    setConflict(false);
                    setError("");
                    setNotice("Der Entwurf verwendet jetzt die geladene Revision. Prüfe alle Werte vor dem Speichern.");
                  }}
                >
                  Entwurf auf geladenem Stand weiterbearbeiten
                </button>
              )}
              <button
                type="button"
                className="ic-btn"
                disabled={loading || busy}
                onClick={() => {
                  adopt(snapshot);
                  setError("");
                }}
              >
                Entwurf verwerfen
              </button>
            </div>
          )}
          <label>
            Begründung der Änderung
            <textarea
              rows={2}
              minLength={10}
              maxLength={1000}
              disabled={!editable || busy}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className="configuration-note">
            Mindestens 10 Zeichen. Die Begründung wird mit Owner, Zeitpunkt und Revision im Audit gespeichert.
          </p>
          <div className="configuration-actions">
            <button
              type="button"
              className="ic-btn primary"
              disabled={
                !editable || loading || busy || !dirty || !valid || stale || conflict || reason.trim().length < 10
              }
              onClick={() => void save()}
            >
              {busy ? "Wird gespeichert …" : "Konfiguration speichern"}
            </button>
            {dirty && <span>Ungespeicherter Entwurf</span>}
          </div>
          <details className="configuration-history">
            <summary>Änderungsverlauf ({snapshot.history.length})</summary>
            {snapshot.history.length === 0 ? (
              <p>Noch keine Änderungen. Es gelten die Ausgangswerte.</p>
            ) : (
              <ol>
                {snapshot.history.map((entry) => (
                  <li key={entry.revision}>
                    <div>
                      <strong>Revision {entry.revision}</strong>
                      <time dateTime={new Date(entry.createdAt).toISOString()}>
                        {new Date(entry.createdAt).toLocaleString("de-DE")}
                      </time>
                      <span>{entry.createdBy}</span>
                    </div>
                    <p>{entry.reason}</p>
                    <details>
                      <summary>Gespeicherte Werte und Audit-Bezug</summary>
                      <pre>{JSON.stringify(entry.configuration, null, 2)}</pre>
                      <p>
                        Audit: <code>{entry.auditEventId}</code>
                        <br />
                        Korrelation: <code>{entry.correlationId}</code>
                      </p>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
      {!snapshot && !loading && <p>Die Konfiguration ist nicht verfügbar. Lade den Serverstand erneut.</p>}
    </section>
  );
}
