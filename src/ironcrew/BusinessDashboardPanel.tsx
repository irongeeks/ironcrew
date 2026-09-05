import { useEffect, useState } from "react";
import type { BusinessDashboardSnapshot, BusinessSource } from "../shared/business-dashboard";
import { requestJson } from "./panel-api";
import "./BusinessDashboardPanel.css";

const defaultClient = {
  load: () => requestJson<BusinessDashboardSnapshot>("/api/crew/business-dashboard"),
  refresh: (source: string, agentId: string) =>
    requestJson<BusinessDashboardSnapshot>(`/api/crew/business-dashboard/${encodeURIComponent(source)}/refresh`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
};
const STATE_LABELS: Record<BusinessSource["state"], string> = {
  not_installed: "Gewerk fehlt",
  not_configured: "Nicht konfiguriert",
  not_refreshed: "Noch nicht abgerufen",
  ok: "Daten vorhanden",
  denied: "Zugriff verweigert",
  approval_required: "Freigabe erforderlich",
  error: "Abruf fehlgeschlagen",
};
export function BusinessDashboardPanel({
  onClose,
  client = defaultClient,
}: {
  onClose: () => void;
  client?: typeof defaultClient;
}) {
  const [snapshot, setSnapshot] = useState<BusinessDashboardSnapshot | null>(null);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    client
      .load()
      .then((data) => {
        if (active) {
          setSnapshot(data);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Geschäftsdaten konnten nicht geladen werden. Owner-Anmeldung prüfen.");
      });
    return () => {
      active = false;
    };
  }, [client, reload]);
  async function refresh(source: string) {
    setBusy(source);
    setError("");
    try {
      setSnapshot(await client.refresh(source, agentId));
    } catch {
      setError("Aktualisierung nicht möglich. Berechtigung prüfen oder laufenden Abruf abwarten.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="business-dashboard" aria-label="Geschäftsdaten">
      <header>
        <div>
          <p className="business-eyebrow">QUELLEN & BETRIEB</p>
          <h2>Geschäftsdaten</h2>
        </div>
        <button type="button" onClick={onClose}>
          Schließen
        </button>
      </header>
      <p>
        Reale Messwerte aus deinen Gewerken. Öffnen liest nur den letzten Abruf; externe Systeme werden erst beim
        Aktualisieren kontaktiert.
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Erneut laden
          </button>
        </p>
      )}
      {!snapshot && !error && <p role="status">Datenquellen werden geladen …</p>}
      {snapshot && (
        <>
          <label className="business-agent">
            Mitarbeiter für den Abruf
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">Mitarbeiter auswählen</option>
              {snapshot.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <p className="business-note">
            Es gelten die bestehenden Werkzeugrechte dieses Mitarbeiters. Keine automatische Freigabe. Alle Abrufe
            werden protokolliert.
          </p>
          <div className="business-sources">
            {snapshot.sources.map((source) => (
              <article key={source.id} aria-label={source.label} data-state={source.state}>
                <div className="business-source-heading">
                  <h3>{source.label}</h3>
                  <span>{STATE_LABELS[source.state]}</span>
                </div>
                <p>{source.message}</p>
                {source.approvalId && (
                  <p className="business-note">
                    Freigabe {source.approvalId}: Im Entscheidungseingang prüfen, danach mit demselben Mitarbeiter
                    erneut aktualisieren. Eine Genehmigung gilt für einen Abruf innerhalb von 15 Minuten.
                  </p>
                )}
                <p className="business-note">
                  Quelle: {source.integration} · Gewerk: {source.packKey}
                </p>
                <code>{source.endpoint}</code>
                <dl className="business-metrics">
                  {source.metrics.map((metric) => (
                    <div key={metric.key}>
                      <dt>{metric.label}</dt>
                      <dd>{metric.value.toLocaleString("de-DE")}</dd>
                    </div>
                  ))}
                </dl>
                <p className="business-note">
                  {source.fetchedAt ? (
                    <>
                      Datenstand:{" "}
                      <time dateTime={new Date(source.fetchedAt).toISOString()}>
                        {new Date(source.fetchedAt).toLocaleString("de-DE")}
                      </time>{" "}
                      · Momentaufnahme
                    </>
                  ) : (
                    "Kein bestätigter Datenstand"
                  )}
                  {source.attemptedAt && !source.fetchedAt
                    ? ` · Letzter Versuch: ${new Date(source.attemptedAt).toLocaleString("de-DE")}`
                    : ""}
                </p>
                {source.records.length > 0 && (
                  <details>
                    <summary>
                      Datengrundlage ansehen ({source.records.length}
                      {source.limited ? ", begrenzt" : ""})
                    </summary>
                    <div className="business-records">
                      <table>
                        <thead>
                          <tr>
                            <th>Eintrag</th>
                            <th>Status</th>
                            <th>Quell-ID</th>
                          </tr>
                        </thead>
                        <tbody>
                          {source.records.map((record, index) => (
                            <tr key={`${record.id}-${index}`}>
                              <td>{record.label}</td>
                              <td>{record.status}</td>
                              <td>{record.id}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                <button
                  type="button"
                  disabled={
                    !agentId || busy !== null || source.state === "not_installed" || source.state === "not_configured"
                  }
                  onClick={() => void refresh(source.id)}
                >
                  {busy === source.id ? "Wird abgerufen …" : `${source.label} aktualisieren`}
                </button>
              </article>
            ))}
          </div>
          <p className="business-note">
            Keine Hochrechnung für Cashflow, Umsatz oder SLA. Ohne angebundene Datenquelle wird keine Kennzahl erfunden.
            Nach einem Neustart ist ein neuer Abruf nötig.
          </p>
        </>
      )}
    </section>
  );
}
