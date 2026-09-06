import { useBusinessLabels } from "./business-labels";
import { useI18n } from "../i18n";
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

export function BusinessDashboardPanel({
  onClose,
  client = defaultClient,
}: {
  onClose: () => void;
  client?: typeof defaultClient;
}) {
  const { t, locale } = useI18n();
  const { sourceLabel, sourceMessage, metricLabel } = useBusinessLabels();
  const STATE_LABELS: Record<BusinessSource["state"], string> = {
    not_installed: t({ de: "Gewerk fehlt", en: "Pack missing" }),
    not_configured: t({ de: "Nicht konfiguriert", en: "Not configured" }),
    not_refreshed: t({ de: "Noch nicht abgerufen", en: "Not fetched yet" }),
    ok: t({ de: "Daten vorhanden", en: "Data available" }),
    denied: t({ de: "Zugriff verweigert", en: "Access denied" }),
    approval_required: t({ de: "Freigabe erforderlich", en: "Approval required" }),
    error: t({ de: "Abruf fehlgeschlagen", en: "Fetch failed" }),
  };
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
        if (active)
          setError(
            t({
              de: "Geschäftsdaten konnten nicht geladen werden. Owner-Anmeldung prüfen.",
              en: "Could not load business data. Check the owner sign-in.",
            }),
          );
      });
    return () => {
      active = false;
    };
  }, [client, reload, t]);
  async function refresh(source: string) {
    setBusy(source);
    setError("");
    try {
      setSnapshot(await client.refresh(source, agentId));
    } catch {
      setError(
        t({
          de: "Aktualisierung nicht möglich. Berechtigung prüfen oder laufenden Abruf abwarten.",
          en: "Cannot refresh. Check permissions or wait for the current fetch to finish.",
        }),
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="business-dashboard" aria-label={t({ de: "Geschäftsdaten", en: "Business data" })}>
      <header>
        <div>
          <p className="business-eyebrow">{t({ de: "QUELLEN & BETRIEB", en: "SOURCES & OPERATIONS" })}</p>
          <h2>{t({ de: "Geschäftsdaten", en: "Business data" })}</h2>
        </div>
        <button type="button" onClick={onClose}>
          {t({ de: "Schließen", en: "Close" })}{" "}
        </button>
      </header>
      <p>
        {t({
          de: "Reale Messwerte aus deinen Gewerken. Öffnen liest nur den letzten Abruf; externe Systeme werden erst beim Aktualisieren kontaktiert.",
          en: "Real metrics from your packs. Opening this view reads the last snapshot; external systems are contacted only when you refresh.",
        })}{" "}
      </p>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            {t({ de: "Erneut laden", en: "Reload" })}{" "}
          </button>
        </p>
      )}
      {!snapshot && !error && (
        <p role="status">{t({ de: "Datenquellen werden geladen …", en: "Loading data sources …" })}</p>
      )}
      {snapshot && (
        <>
          <label className="business-agent">
            {t({ de: "Mitarbeiter für den Abruf", en: "Employee for the fetch" })}{" "}
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">{t({ de: "Mitarbeiter auswählen", en: "Select employee" })}</option>
              {snapshot.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <p className="business-note">
            {t({
              de: "Es gelten die bestehenden Werkzeugrechte dieses Mitarbeiters. Keine automatische Freigabe. Alle Abrufe werden protokolliert.",
              en: "The employee’s existing tool permissions apply. There is no automatic approval. Every fetch is logged.",
            })}{" "}
          </p>
          <div className="business-sources">
            {snapshot.sources.map((source) => (
              <article key={source.id} aria-label={sourceLabel(source)} data-state={source.state}>
                <div className="business-source-heading">
                  <h3>{sourceLabel(source)}</h3>
                  <span>{STATE_LABELS[source.state]}</span>
                </div>
                <p>{sourceMessage(source)}</p>
                {source.approvalId && (
                  <p className="business-note">
                    {t({ de: "Freigabe", en: "Approval" })} {source.approvalId}
                    {t({
                      de: ": Im Entscheidungseingang prüfen, danach mit demselben Mitarbeiter erneut aktualisieren. Eine Genehmigung gilt für einen Abruf innerhalb von 15 Minuten.",
                      en: ": review in the decision inbox, then refresh again using the same employee. Approval is valid for one fetch within 15 minutes.",
                    })}{" "}
                  </p>
                )}
                <p className="business-note">
                  {t({ de: "Quelle:", en: "Source:" })} {source.integration} {t({ de: "· Gewerk:", en: "· Pack:" })}{" "}
                  {source.packKey}
                </p>
                <code>{source.endpoint}</code>
                <dl className="business-metrics">
                  {source.metrics.map((metric) => (
                    <div key={metric.key}>
                      <dt>{metricLabel(source, metric)}</dt>
                      <dd>{metric.value.toLocaleString(locale)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="business-note">
                  {source.fetchedAt ? (
                    <>
                      {t({ de: "Datenstand:", en: "Data as of:" })}{" "}
                      <time dateTime={new Date(source.fetchedAt).toISOString()}>
                        {new Date(source.fetchedAt).toLocaleString(locale)}
                      </time>{" "}
                      {t({ de: "· Momentaufnahme", en: "· Snapshot" })}{" "}
                    </>
                  ) : (
                    t({ de: "Kein bestätigter Datenstand", en: "No confirmed data snapshot" })
                  )}
                  {source.attemptedAt && !source.fetchedAt
                    ? t({
                        de: ` · Letzter Versuch: ${new Date(source.attemptedAt).toLocaleString(locale)}`,
                        en: ` · Last attempt: ${new Date(source.attemptedAt).toLocaleString(locale)}`,
                      })
                    : ""}
                </p>
                {source.records.length > 0 && (
                  <details>
                    <summary>
                      {t({ de: "Datengrundlage ansehen (", en: "View source records (" })}
                      {source.records.length}
                      {source.limited ? t({ de: ", begrenzt", en: ", limited" }) : ""})
                    </summary>
                    <div className="business-records">
                      <table>
                        <thead>
                          <tr>
                            <th>{t({ de: "Eintrag", en: "Record" })}</th>
                            <th>Status</th>
                            <th>{t({ de: "Quell-ID", en: "Source ID" })}</th>
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
                  {busy === source.id
                    ? t({ de: "Wird abgerufen …", en: "Fetching …" })
                    : t({ de: `${sourceLabel(source)} aktualisieren`, en: `Refresh ${sourceLabel(source)}` })}
                </button>
              </article>
            ))}
          </div>
          <p className="business-note">
            {t({
              de: "Keine Hochrechnung für Cashflow, Umsatz oder SLA. Ohne angebundene Datenquelle wird keine Kennzahl erfunden. Nach einem Neustart ist ein neuer Abruf nötig.",
              en: "No projections for cash flow, revenue or SLA. Metrics are never invented without a connected data source. Refresh again after a restart.",
            })}{" "}
          </p>
        </>
      )}
    </section>
  );
}
