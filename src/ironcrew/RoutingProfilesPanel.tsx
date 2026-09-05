import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, request } from "../api/core";
import {
  ROUTING_CAPABILITIES,
  routeTargetSchema,
  routingConfigSchema,
  type RouteTarget,
  type RoutingConfig,
  type RoutingProfile,
  type RoutingSnapshot,
} from "../shared/routing-profiles";
import { requestJson } from "./panel-api";
import "./RoutingProfilesPanel.css";

export interface RoutingProfilesPanelProps {
  agents: Array<{ id: string; displayName: string }>;
  canManage?: boolean;
  refreshKey?: number;
}

const CAPABILITY_LABEL: Record<(typeof ROUTING_CAPABILITIES)[number], string> = {
  streaming: "Streaming",
  toolCalls: "Werkzeugaufrufe",
  sessionResume: "Session fortsetzen",
  subagents: "Subagents",
  vision: "Bildverarbeitung",
  longContext: "Langer Kontext",
};
const SENSITIVITY_LABEL = { internal: "Intern", confidential: "Vertraulich" } as const;
const blankTarget = (): RouteTarget => ({ vesselId: "", runtimeType: "mock", model: "", vendorModel: "" });
function vendorModelFor(runtime: RouteTarget["runtimeType"], model: string): string {
  if (model.includes("/")) return model;
  const prefix =
    runtime === "claude"
      ? "anthropic"
      : runtime === "codex"
        ? "openai"
        : runtime === "antigravity" || runtime === "gemini"
          ? "google"
          : "";
  return prefix && model ? `${prefix}/${model}` : model;
}
function jsonPut<T>(url: string, value: unknown): Promise<T> {
  return requestJson<T>(url, { method: "PUT", body: JSON.stringify(value) });
}
function readableError(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.details && typeof cause.details === "object") {
    const message = (cause.details as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return cause instanceof Error ? cause.message : "Die Routing-Einstellungen konnten nicht gespeichert werden.";
}

function TargetEditor({
  title,
  target,
  vessels,
  onChange,
  controls,
}: {
  title: string;
  target: RouteTarget | null;
  vessels: RoutingSnapshot["vessels"];
  onChange: (target: RouteTarget | null) => void;
  controls?: React.ReactNode;
}): React.JSX.Element {
  const choose = (id: string) => {
    if (!id) {
      onChange(null);
      return;
    }
    const vessel = vessels.find((item) => item.id === id);
    const runtime = routeTargetSchema.shape.runtimeType.safeParse(vessel?.runtime_provider);
    if (!vessel || !runtime.success) return;
    onChange({
      vesselId: vessel.id,
      runtimeType: runtime.data,
      model: vessel.model,
      vendorModel: vendorModelFor(runtime.data, vessel.model),
    });
  };
  return (
    <section className="routing-target" aria-label={title}>
      <header>
        <h4>{title}</h4>
        {target?.vesselId && (
          <span className="routing-target-runtime">
            Runtime: <strong>{target.runtimeType}</strong>
          </span>
        )}
        {controls}
      </header>
      <div className="routing-target-fields">
        <label>
          {title}: Vessel
          <select value={target?.vesselId ?? ""} onChange={(event) => choose(event.target.value)}>
            <option value="">Kein Ziel konfiguriert</option>
            {vessels.map((vessel) => (
              <option
                key={vessel.id}
                value={vessel.id}
                disabled={!routeTargetSchema.shape.runtimeType.safeParse(vessel.runtime_provider).success}
              >
                {vessel.label} · {vessel.runtime_provider}
              </option>
            ))}
          </select>
        </label>
        {target && (
          <>
            <label>
              {title}: Modell
              <input
                type="text"
                value={target.model}
                placeholder="Exakte Modell-ID oder CLI-Alias"
                onChange={(event) =>
                  onChange({
                    ...target,
                    model: event.target.value,
                    vendorModel: vendorModelFor(target.runtimeType, event.target.value),
                  })
                }
              />
            </label>
            <label>
              {title}: Vendor-Modell
              <input
                type="text"
                value={target.vendorModel}
                placeholder="Anbieter/Modell für die Vendor-Policy"
                onChange={(event) => onChange({ ...target, vendorModel: event.target.value })}
              />
            </label>
          </>
        )}
      </div>
      {target && (
        <p className="routing-note">
          Die Runtime erhält das Modell exakt als Argument. Bei Modell-IDs mit „/“ muss das Vendor-Modell identisch
          sein. CLI-Aliase verwenden ausschließlich den festen Anbieterpräfix: Claude → anthropic/, Codex → openai/,
          Google → google/.
        </p>
      )}
    </section>
  );
}

export function RoutingProfilesPanel({
  agents,
  canManage = false,
  refreshKey = 0,
}: RoutingProfilesPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoutingSnapshot | null>(null);
  const [draft, setDraft] = useState<RoutingConfig | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string>("coding");
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const generation = useRef(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (discard = false) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const result = await request<RoutingSnapshot>("/api/crew/routing");
      if (generation.current !== token) return;
      setSnapshot(result);
      if (!dirtyRef.current || discard) {
        setDraft(structuredClone(result.config));
        setBaseRevision(result.revision);
        dirtyRef.current = false;
        setDirty(false);
        setConflict(false);
      }
      if (discard) {
        setBindingDrafts({});
        setError("");
        setNotice("Aktueller Serverstand geladen. Lokale Änderungen wurden verworfen.");
      }
    } catch (cause) {
      if (generation.current === token) setError(readableError(cause));
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, []);
  const invalidateRequests = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidateRequests;
  }, [load, refreshKey, invalidateRequests]);

  const profile = draft?.profiles.find((item) => item.key === selectedKey) ?? draft?.profiles[0];
  const patchProfile = (patch: Partial<RoutingProfile>) => {
    if (!profile || !canManage) return;
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((item) => (item.key === profile.key ? { ...item, ...patch } : item)),
          }
        : null,
    );
    dirtyRef.current = true;
    setDirty(true);
    setNotice("");
  };
  const moveFallback = (index: number, direction: -1 | 1) => {
    if (!profile) return;
    const next = [...profile.fallbacks];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    patchProfile({ fallbacks: next });
  };
  const saveConfig = async () => {
    if (!draft || !canManage || !routingConfigSchema.safeParse(draft).success) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await jsonPut("/api/crew/routing", { expectedRevision: baseRevision, config: draft });
      dirtyRef.current = false;
      setDirty(false);
      setConflict(false);
      setNotice("Routing-Profile gespeichert. Die neue Konfiguration gilt für folgende Runs.");
      await load();
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 409) {
        setConflict(true);
        setError(
          "Der Serverstand wurde zwischenzeitlich geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand, bevor du ihn erneut bearbeitest.",
        );
      } else setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  };
  const bindAgent = async (agentId: string) => {
    if (!canManage) return;
    const current = snapshot?.bindings.find((binding) => binding.agentId === agentId)?.profileKey ?? "";
    const value = bindingDrafts[agentId] ?? current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await jsonPut(`/api/crew/routing/agents/${encodeURIComponent(agentId)}`, { profileKey: value || null });
      setBindingDrafts((previous) => {
        const next = { ...previous };
        delete next[agentId];
        return next;
      });
      setNotice(
        value
          ? "Profil dem Agenten zugeordnet."
          : "Profilzuordnung entfernt. Der Agent verwendet wieder sein bestehendes Vessel.",
      );
      await load();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  };
  const validDraft = draft ? routingConfigSchema.safeParse(draft).success : false;

  return (
    <section className="routing-panel" aria-label="Modellprofile und Routing" aria-busy={busy || loading}>
      <header>
        <div>
          <h2>Modellprofile &amp; Routing</h2>
          <p>
            Runtimes und Modelle bewusst zuordnen. Fallbacks bleiben an Datenschutz, Fähigkeiten und Vendor-Policy
            gebunden.
          </p>
        </div>
        <div className="routing-toolbar">
          {snapshot && <span className="routing-revision">Revision {snapshot.revision}</span>}
          <button type="button" className="ic-btn" disabled={busy || loading} onClick={() => void load()}>
            Serverstand prüfen
          </button>
        </div>
      </header>
      {!canManage && <p className="routing-note">Leseansicht: Nur der Owner kann Profile und Zuordnungen ändern.</p>}
      {loading && <p role="status">Routing-Konfiguration wird geladen …</p>}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status" className="routing-notice">
          {notice}
        </p>
      )}
      {snapshot && dirty && snapshot.revision !== baseRevision && (
        <p role="alert">
          Auf dem Server liegt Revision {snapshot.revision}; dein Entwurf basiert auf Revision {baseRevision}.
        </p>
      )}
      {!snapshot && !loading && (
        <p className="routing-empty">
          Die Routing-Konfiguration ist noch nicht verfügbar. Über „Serverstand prüfen“ erneut laden.
        </p>
      )}
      {draft && snapshot && (
        <>
          <nav className="routing-profile-navigation" aria-label="Routing-Profile">
            {draft.profiles.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={profile?.key === item.key}
                data-unconfigured={!item.primary || undefined}
                onClick={() => setSelectedKey(item.key)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {profile && (
            <fieldset className="routing-profile-form" disabled={busy || !canManage}>
              <legend>{profile.key}</legend>
              <label>
                Profilbezeichnung
                <input
                  type="text"
                  value={profile.label}
                  maxLength={120}
                  onChange={(event) => patchProfile({ label: event.target.value })}
                />
              </label>
              <TargetEditor
                title="Primärziel"
                target={profile.primary}
                vessels={snapshot.vessels}
                onChange={(primary) =>
                  patchProfile(primary ? { primary } : { primary: null, fallbacks: [], allowFallback: false })
                }
              />
              {!profile.primary && (
                <p className="routing-note">
                  Noch nicht konfiguriert. Dieses Profil startet keinen Run. Wähle ein Vessel und ein konkretes Modell.
                </p>
              )}
              <label className="routing-check">
                <input
                  type="checkbox"
                  checked={profile.allowFallback}
                  disabled={!profile.primary}
                  onChange={(event) => patchProfile({ allowFallback: event.target.checked })}
                />
                Automatischen Fallback ausdrücklich erlauben
              </label>
              <p className="routing-note">
                Gespeicherte Ersatzziele werden ausschließlich in dieser Reihenfolge und nach erneuter Policy-Prüfung
                verwendet. Ohne Freigabe erfolgt kein automatischer Wechsel.
              </p>
              <ol className="routing-fallback-list">
                {profile.fallbacks.map((target, index) => (
                  <li key={index}>
                    <TargetEditor
                      title={`Fallback ${index + 1}`}
                      target={target}
                      vessels={snapshot.vessels}
                      onChange={(next) =>
                        patchProfile({
                          fallbacks: profile.fallbacks.map((value, at) =>
                            at === index ? (next ?? blankTarget()) : value,
                          ),
                        })
                      }
                      controls={
                        <div className="routing-target-controls">
                          <button
                            type="button"
                            className="ic-btn"
                            aria-label={`Fallback ${index + 1} nach oben`}
                            disabled={index === 0}
                            onClick={() => moveFallback(index, -1)}
                          >
                            Nach oben
                          </button>
                          <button
                            type="button"
                            className="ic-btn"
                            aria-label={`Fallback ${index + 1} nach unten`}
                            disabled={index === profile.fallbacks.length - 1}
                            onClick={() => moveFallback(index, 1)}
                          >
                            Nach unten
                          </button>
                          <button
                            type="button"
                            className="ic-btn"
                            aria-label={`Fallback ${index + 1} entfernen`}
                            onClick={() =>
                              patchProfile({ fallbacks: profile.fallbacks.filter((_item, at) => at !== index) })
                            }
                          >
                            Entfernen
                          </button>
                        </div>
                      }
                    />
                  </li>
                ))}
              </ol>
              <button
                type="button"
                className="ic-btn"
                disabled={!profile.primary || profile.fallbacks.length >= 4}
                onClick={() => patchProfile({ fallbacks: [...profile.fallbacks, blankTarget()] })}
              >
                Fallback hinzufügen
              </button>
              <div className="routing-policies">
                <fieldset>
                  <legend>Erlaubte Sensitivität</legend>
                  {(Object.entries(SENSITIVITY_LABEL) as [RoutingProfile["allowedSensitivity"][number], string][]).map(
                    ([value, label]) => (
                      <label className="routing-check" key={value}>
                        <input
                          type="checkbox"
                          checked={profile.allowedSensitivity.includes(value)}
                          onChange={(event) =>
                            patchProfile({
                              allowedSensitivity: event.target.checked
                                ? [...profile.allowedSensitivity, value]
                                : profile.allowedSensitivity.filter((item) => item !== value),
                            })
                          }
                        />
                        {label}
                      </label>
                    ),
                  )}
                </fieldset>
                <fieldset>
                  <legend>Erforderliche Fähigkeiten</legend>
                  {ROUTING_CAPABILITIES.map((value) => (
                    <label className="routing-check" key={value}>
                      <input
                        type="checkbox"
                        checked={profile.requiredCapabilities.includes(value)}
                        onChange={(event) =>
                          patchProfile({
                            requiredCapabilities: event.target.checked
                              ? [...profile.requiredCapabilities, value]
                              : profile.requiredCapabilities.filter((item) => item !== value),
                          })
                        }
                      />
                      {CAPABILITY_LABEL[value]}
                    </label>
                  ))}
                </fieldset>
              </div>
              <p className="routing-note">
                Nicht gemeldete Fähigkeiten gelten als nicht verfügbar. Ein Ziel ohne alle geforderten Fähigkeiten wird
                abgelehnt.
              </p>
            </fieldset>
          )}
          {canManage && (
            <div className="routing-actions">
              <button
                type="button"
                className="ic-btn"
                data-variant="primary"
                disabled={busy || !dirty || !validDraft || conflict || snapshot.revision !== baseRevision}
                onClick={() => void saveConfig()}
              >
                Alle Routing-Profile speichern
              </button>
              {(dirty || conflict) && (
                <button
                  type="button"
                  className="ic-btn"
                  disabled={busy || loading}
                  onClick={() => {
                    setBusy(true);
                    void load(true).finally(() => setBusy(false));
                  }}
                >
                  Serverstand laden und Entwurf verwerfen
                </button>
              )}
              {dirty && !validDraft && (
                <span className="routing-note">
                  Mindestens ein Profil ist unvollständig: Ziele, Modelle, eindeutige Fallbacks und Sensitivität prüfen.
                </span>
              )}
            </div>
          )}
          <section className="routing-bindings" aria-label="Profilzuordnung der Agents">
            <h3>Profile den Agents zuordnen</h3>
            <p className="routing-note">
              Ohne Profilzuordnung bleibt das bestehende Vessel des Agenten zuständig. Ein unkonfiguriertes Profil
              erlaubt keine Ausführung.
            </p>
            <ul className="routing-binding-list">
              {agents.map((agent) => {
                const current = snapshot.bindings.find((binding) => binding.agentId === agent.id)?.profileKey ?? "";
                const selected = bindingDrafts[agent.id] ?? current;
                return (
                  <li key={agent.id}>
                    <strong>{agent.displayName}</strong>
                    <label>
                      Routingprofil für {agent.displayName}
                      <select
                        disabled={busy || !canManage}
                        value={selected}
                        onChange={(event) =>
                          setBindingDrafts((previous) => ({ ...previous, [agent.id]: event.target.value }))
                        }
                      >
                        <option value="">Bestehendes Vessel verwenden</option>
                        {snapshot.config.profiles.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.label}
                            {item.primary ? "" : " · nicht konfiguriert"}
                          </option>
                        ))}
                      </select>
                    </label>
                    {canManage && (
                      <button
                        type="button"
                        className="ic-btn"
                        disabled={busy || selected === current}
                        onClick={() => void bindAgent(agent.id)}
                        aria-label={`Zuordnung für ${agent.displayName} speichern`}
                      >
                        Zuordnung speichern
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {agents.length === 0 && <p>Noch keine Agents vorhanden.</p>}
          </section>
          <details className="routing-history">
            <summary>Versionshistorie ({snapshot.history.length})</summary>
            <ul>
              {snapshot.history.map((entry) => (
                <li key={entry.revision}>
                  <strong>Revision {entry.revision}</strong>
                  <span>{new Date(entry.createdAt).toLocaleString("de-DE")}</span>
                  <span>{entry.createdBy}</span>
                </li>
              ))}
            </ul>
            {snapshot.history.length === 0 && <p>Noch keine gespeicherten Änderungen.</p>}
          </details>
        </>
      )}
    </section>
  );
}
