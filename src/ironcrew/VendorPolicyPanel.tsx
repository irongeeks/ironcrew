import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/core";
import type { CompanyPolicyRestrictions, CompanyPolicySnapshot } from "../shared/company-policy";
import { vendorPolicyApi, type VendorModelCheck } from "./vendor-policy-api";
import "./VendorPolicyPanel.css";

function errorText(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.details && typeof cause.details === "object") {
    const message = (cause.details as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return cause instanceof Error ? cause.message : "Die Anfrage konnte nicht abgeschlossen werden.";
}

export function VendorPolicyPanel({
  canManage = false,
  refreshKey = 0,
}: {
  canManage?: boolean;
  refreshKey?: number;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CompanyPolicySnapshot | null>(null);
  const [draft, setDraft] = useState<CompanyPolicyRestrictions | null>(null);
  const [base, setBase] = useState({ revision: 0, fingerprint: "" });
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
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<VendorModelCheck | null>(null);
  const [checkError, setCheckError] = useState("");
  const checkGeneration = useRef(0);

  const adopt = useCallback((result: CompanyPolicySnapshot) => {
    setDraft(structuredClone(result.restrictions));
    setBase({ revision: result.revision, fingerprint: result.baselineFingerprint });
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
      const result = await vendorPolicyApi.load();
      if (generation.current !== token) return;
      setSnapshot(result);
      setCheck(null);
      checkGeneration.current++;
      setChecking(false);
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
    checkGeneration.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return invalidateRequests;
  }, [invalidateRequests]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const stale = snapshot && (snapshot.revision !== base.revision || snapshot.baselineFingerprint !== base.fingerprint);
  const valid =
    draft &&
    snapshot &&
    draft.allowedFamilies.every((item) => snapshot.baseline.allowedFamilies.includes(item)) &&
    draft.allowedProviders.every((item) => snapshot.baseline.allowedProviders.includes(item));
  const change = (field: keyof CompanyPolicyRestrictions, item: string, selected: boolean) => {
    if (!canManage || busy) return;
    setDraft((current) =>
      current
        ? {
            ...current,
            [field]: selected ? [...current[field], item] : current[field].filter((value) => value !== item),
          }
        : current,
    );
    dirtyRef.current = true;
    setDirty(true);
    setNotice("");
  };
  const save = async () => {
    if (!canManage || !draft || !valid || !dirty || stale || conflict || saving.current || reason.trim().length < 10)
      return;
    saving.current = true;
    generation.current++;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await vendorPolicyApi.save({
        baseRevision: base.revision,
        baselineFingerprint: base.fingerprint,
        reason: reason.trim(),
        restrictions: draft,
      });
      if (!mounted.current) return;
      setSnapshot(result);
      adopt(result);
      setCheck(null);
      checkGeneration.current++;
      setChecking(false);
      setNotice(`Freigaben gespeichert. Revision ${result.revision} gilt für folgende Modellanfragen.`);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiRequestError && cause.status === 409) {
        setConflict(true);
        setError(
          "Der Serverstand oder die zentrale Policy wurde geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Serverstand und vergleiche die Freigaben.",
        );
      } else setError(errorText(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const checkModel = async () => {
    if (!model.trim() || checking) return;
    const token = ++checkGeneration.current;
    setChecking(true);
    setCheck(null);
    setCheckError("");
    try {
      const result = await vendorPolicyApi.check(model.trim(), provider.trim() || undefined);
      if (token === checkGeneration.current) setCheck(result);
    } catch (cause) {
      if (token === checkGeneration.current) setCheckError(errorText(cause));
    } finally {
      if (token === checkGeneration.current) setChecking(false);
    }
  };

  return (
    <section className="vendor-policy-panel" aria-label="Vendor- und Provider-Freigaben" aria-busy={loading || busy}>
      <header>
        <div>
          <h2>Vendor- &amp; Provider-Freigaben</h2>
          <p>Lege fest, welche Modellfamilien und OpenRouter-Provider deine Firma verwenden darf.</p>
        </div>
        <div className="vendor-policy-toolbar">
          {snapshot && <span className="vendor-policy-revision">Revision {snapshot.revision}</span>}
          <button type="button" className="ic-btn" disabled={loading || busy} onClick={() => void load()}>
            Serverstand laden
          </button>
        </div>
      </header>
      {!canManage && <p className="vendor-policy-note">Leseansicht: Nur der Owner kann Freigaben ändern.</p>}
      {loading && (
        <div className="vendor-policy-loading" role="status">
          Freigaben werden geladen …<div aria-hidden="true" />
          <div aria-hidden="true" />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status" className="vendor-policy-notice">
          {notice}
        </p>
      )}
      {!snapshot && !loading && <p>Die Freigaben sind noch nicht verfügbar. Lade den Serverstand erneut.</p>}
      {snapshot && draft && (
        <>
          <section className="vendor-policy-baseline" aria-label="Zentrale Schutzregeln">
            <h3>
              Zentrale Schutzregeln <span>Fest vorgegeben</span>
            </h3>
            <p>
              Die zentrale Policy begrenzt alle Freigaben. Diese Ansicht kann ihre Sperren, Datenschutzregeln und
              Telemetrie-Einstellungen nicht ändern.
            </p>
            <details>
              <summary>Gesperrte Modellfamilien ({snapshot.effectivePolicy.blocked_families.length})</summary>
              <ul className="vendor-policy-blocks">
                {snapshot.effectivePolicy.blocked_families.map((item) => (
                  <li key={item.id}>
                    <strong>{item.id}</strong>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>Gesperrte Dienste ({snapshot.effectivePolicy.blocked_endpoints.length})</summary>
              <ul className="vendor-policy-blocks">
                {snapshot.effectivePolicy.blocked_endpoints.map((item) => (
                  <li key={item.id}>
                    <strong>{item.id}</strong>
                    <span>{item.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
            <dl className="vendor-policy-rules">
              <div>
                <dt>OpenRouter-Fallback</dt>
                <dd>
                  {snapshot.effectivePolicy.openrouter.allow_fallbacks
                    ? "Innerhalb der Provider-Freigaben"
                    : "Ausgeschaltet"}
                </dd>
              </div>
              <div>
                <dt>Sensible Aufgaben</dt>
                <dd>
                  Datensammlung:{" "}
                  {snapshot.effectivePolicy.openrouter.sensitive_defaults.data_collection === "deny"
                    ? "verboten"
                    : "erlaubt"}{" "}
                  · ZDR:{" "}
                  {snapshot.effectivePolicy.openrouter.sensitive_defaults.zdr ? "erforderlich" : "nicht vorgeschrieben"}{" "}
                  · Fallback:{" "}
                  {snapshot.effectivePolicy.openrouter.sensitive_defaults.allow_fallbacks
                    ? "innerhalb der Provider-Freigaben"
                    : "ausgeschaltet"}
                </dd>
              </div>
              <div>
                <dt>Telemetrie</dt>
                <dd>
                  {snapshot.effectivePolicy.telemetry.enabled ? "In zentraler Policy aktiviert" : "Ausgeschaltet"}
                </dd>
              </div>
            </dl>
          </section>
          {stale && (
            <section aria-label="Geladener Serverstand">
              <p role="alert">
                Der Entwurf basiert auf Revision {base.revision}. Der geladene Serverstand (Revision {snapshot.revision}
                ) oder seine zentrale Policy ist neuer. Deine Auswahl und Begründung bleiben erhalten.
              </p>
              <p>Aktive Modellfamilien: {snapshot.effectivePolicy.allowed_families.join(", ") || "keine"}</p>
              <p>
                Aktive OpenRouter-Provider:{" "}
                {snapshot.effectivePolicy.openrouter.allowed_providers.join(", ") || "keine"}
              </p>
              <p className="vendor-policy-note">
                Erneutes Speichern übernimmt deine vollständige Auswahl als neue Firmenfreigabe.
              </p>
            </section>
          )}
          {canManage && (conflict || stale) && (
            <div className="vendor-policy-actions">
              {stale && valid && (
                <button
                  type="button"
                  className="ic-btn"
                  disabled={busy || loading}
                  onClick={() => {
                    setBase({ revision: snapshot.revision, fingerprint: snapshot.baselineFingerprint });
                    setConflict(false);
                    setError("");
                    setNotice(
                      "Dein Entwurf basiert jetzt auf dem geladenen Stand. Prüfe die Auswahl vor dem Speichern erneut.",
                    );
                  }}
                >
                  Entwurf auf geladenem Stand weiterbearbeiten
                </button>
              )}
              <button
                type="button"
                className="ic-btn"
                disabled={busy || loading}
                onClick={() => {
                  adopt(snapshot);
                  setError("");
                  setNotice("Geladener Serverstand übernommen. Der Entwurf wurde verworfen.");
                }}
              >
                Entwurf verwerfen und Serverstand übernehmen
              </button>
            </div>
          )}
          <div className="vendor-policy-selections">
            {(
              [
                ["allowedFamilies", "Modellfamilien"],
                ["allowedProviders", "OpenRouter-Provider"],
              ] as const
            ).map(([field, label]) => (
              <fieldset key={field} disabled={!canManage || busy || loading}>
                <legend>{label}</legend>
                <p>
                  {field === "allowedFamilies"
                    ? "Gilt auch für CLI-Runtimes und Routing-Fallbacks."
                    : "Gilt für die ausführenden Anbieter hinter OpenRouter."}
                </p>
                {snapshot.baseline[field].map((item) => (
                  <label className="vendor-policy-check" key={item}>
                    <input
                      type="checkbox"
                      checked={draft[field].includes(item)}
                      onChange={(event) => change(field, item, event.target.checked)}
                    />
                    <span>{item}</span>
                  </label>
                ))}
                {draft[field]
                  .filter((item) => !snapshot.baseline[field].includes(item))
                  .map((item) => (
                    <label className="vendor-policy-check" key={item}>
                      <input type="checkbox" checked onChange={() => change(field, item, false)} />
                      <span>{item} — zentral nicht mehr erlaubt; Auswahl entfernen</span>
                    </label>
                  ))}
                {snapshot.baseline[field].length === 0 && <p>Die zentrale Policy gibt keine Einträge frei.</p>}
              </fieldset>
            ))}
          </div>
          <section className="vendor-policy-preview" aria-label="Vorschau der Freigaben">
            <h3>{dirty ? "Vorschau deines Entwurfs" : "Aktive Freigaben"}</h3>
            <p>
              {dirty ? "Noch nicht gespeichert. " : ""}Modellfamilien:{" "}
              {draft.allowedFamilies.filter((item) => snapshot.baseline.allowedFamilies.includes(item)).join(", ") ||
                "keine"}
            </p>
            <p>
              OpenRouter-Provider:{" "}
              {draft.allowedProviders.filter((item) => snapshot.baseline.allowedProviders.includes(item)).join(", ") ||
                "keine"}
            </p>
            {draft.allowedFamilies.length === 0 && (
              <p className="vendor-policy-warning">
                Keine Modellfamilie ausgewählt: Alle Modellanfragen werden blockiert.
              </p>
            )}
            {draft.allowedProviders.length === 0 && (
              <p className="vendor-policy-warning">Kein Provider ausgewählt: OpenRouter-Anfragen werden blockiert.</p>
            )}
            {!valid && <p role="alert">Entferne die Auswahlen, die in der zentralen Policy nicht mehr erlaubt sind.</p>}
            <p className="vendor-policy-note">
              Zentrale Sperren haben immer Vorrang. Eine Freigabe bestätigt keine Modellverfügbarkeit, Anmeldung oder
              ausreichendes Budget.
            </p>
          </section>
          {canManage && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label>
                Begründung der Änderung
                <textarea
                  value={reason}
                  minLength={10}
                  maxLength={1000}
                  rows={3}
                  disabled={busy || loading}
                  onChange={(event) => {
                    setReason(event.target.value);
                    dirtyRef.current = true;
                    setDirty(true);
                    setNotice("");
                  }}
                  aria-describedby="vendor-policy-reason-help"
                />
              </label>
              <p id="vendor-policy-reason-help" className="vendor-policy-note">
                Mindestens 10 Zeichen. Die Begründung wird mit deiner Identität in Verlauf und Audit gespeichert.
              </p>
              <div className="vendor-policy-actions">
                <button
                  type="submit"
                  className="ic-btn"
                  data-variant="primary"
                  disabled={busy || loading || !dirty || !valid || !!stale || conflict || reason.trim().length < 10}
                >
                  {busy ? "Freigaben werden gespeichert …" : "Freigaben speichern"}
                </button>
              </div>
            </form>
          )}
          <section className="vendor-policy-model-check" aria-label="Modell prüfen">
            <h3>Modell gegen gespeicherte Freigaben prüfen</h3>
            <p>
              Prüft ausschließlich den gespeicherten Serverstand. Dabei wird kein Modell gestartet und kein Provider
              kontaktiert.
            </p>
            <p className="vendor-policy-note">
              Ohne Provider wird nur die Modellfamilie geprüft. Für OpenRouter zusätzlich den konkreten Provider
              angeben.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void checkModel();
              }}
            >
              <div className="vendor-policy-check-fields">
                <label>
                  Modell-ID
                  <input
                    type="text"
                    value={model}
                    maxLength={250}
                    placeholder="anbieter/modell"
                    disabled={checking || busy}
                    onChange={(event) => {
                      setModel(event.target.value);
                      setCheck(null);
                    }}
                  />
                </label>
                <label>
                  Provider (optional)
                  <input
                    type="text"
                    value={provider}
                    maxLength={200}
                    placeholder="Name des OpenRouter-Providers"
                    disabled={checking || busy}
                    onChange={(event) => {
                      setProvider(event.target.value);
                      setCheck(null);
                    }}
                  />
                </label>
              </div>
              <button type="submit" className="ic-btn" disabled={checking || busy || !model.trim()}>
                {checking ? "Modell wird geprüft …" : "Gespeicherte Policy prüfen"}
              </button>
            </form>
            {checkError && <p role="alert">{checkError}</p>}
            {check && (
              <p role="status" className={check.decision.allowed ? "vendor-policy-notice" : "vendor-policy-warning"}>
                <strong>
                  {check.decision.allowed ? "Erlaubt" : "Blockiert"}: {check.model}
                </strong>
                {check.provider ? ` · ${check.provider}` : ""} — {check.decision.reason} (geprüfte Revision{" "}
                {check.revision})
              </p>
            )}
          </section>
          <details className="vendor-policy-history">
            <summary>Änderungsverlauf ({snapshot.history.length})</summary>
            {snapshot.history.length === 0 ? (
              <p>Noch keine Firmenänderung gespeichert. Es gelten die zentralen Freigaben.</p>
            ) : (
              <ol>
                {snapshot.history.map((item) => (
                  <li key={item.revision}>
                    <div>
                      <strong>Revision {item.revision}</strong>
                      <time dateTime={new Date(item.createdAt).toISOString()}>
                        {new Date(item.createdAt).toLocaleString("de-DE")}
                      </time>
                      <span>{item.createdBy}</span>
                    </div>
                    <p>{item.reason}</p>
                    <p>
                      Familien: {item.restrictions.allowedFamilies.join(", ") || "keine"} · Provider:{" "}
                      {item.restrictions.allowedProviders.join(", ") || "keine"}
                    </p>
                    <p className="vendor-policy-note">
                      Audit: {item.auditEventId} · Korrelation: {item.correlationId}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}
