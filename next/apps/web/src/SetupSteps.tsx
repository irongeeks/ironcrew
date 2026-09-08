import { useState, type FormEvent } from "react";
import { ConfigurationPanel, MandatePanel, SchedulePanel } from "./Workflows.tsx";
import { Workers, Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import Channels from "./Channels.tsx";
import Entities from "./Entities.tsx";
import { request, string as str, money } from "./api.ts";
import styles from "./App.module.css";
export default function SetupSteps({ step, locale }: { step: number; locale: Locale }) {
  const company = useRemote("/company"),
    crew = useRemote("/employees"),
    areas = useRemote("/areas"),
    configuration = useRemote("/configuration"),
    models = useRemote("/models"),
    workers = useRemote("/workers"),
    mandates = useRemote("/mandates"),
    schedules = useRemote("/schedules"),
    budget = useRemote("/budget");
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  async function save(
    event: FormEvent<HTMLFormElement>,
    path: string,
    method: "POST" | "PATCH" | "PUT",
    revision?: unknown,
  ) {
    event.preventDefault();
    const form = event.currentTarget,
      data = Object.fromEntries(new FormData(form));
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await request(path, { method, body: data, revision });
      crew.reload();
      areas.reload();
      company.reload();
      setMessage(t("Änderung gespeichert.", "Change saved."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sources = [company, crew, areas, configuration, models, workers, mandates, schedules, budget];
  if (company.loading || (step === 7 && sources.some((source) => source.loading)))
    return <p role="status">{t("Firmenstand wird geladen…", "Loading company state…")}</p>;
  return (
    <div>
      <Feedback error={error || sources.find((source) => source.error)?.error || ""} message={message} />
      {step === 1 && (
        <section aria-label={t("Crewprofile einrichten", "Configure crew profiles")}>
          <p>
            {t(
              "Die mitgelieferten Iron-Geeks-Logos kennzeichnen deine Firma. Neun Rollen sind tatsächlich angelegt; Namen, Persona und Erscheinungsbeschreibung lassen sich hier speichern.",
              "The supplied Iron Geeks logos identify your company. Nine roles have been created; save names, personas and appearance descriptions here.",
            )}
          </p>
          <img src="/brand/wordmark.png" alt="Iron Geeks" style={{ maxWidth: "100%", maxHeight: 80 }} />
          {records(crew.data.items).map((employee) => (
            <details key={str(employee, "id")}>
              <summary>{str(employee, "displayName")}</summary>
              <form onSubmit={(e) => void save(e, `/employees/${str(employee, "id")}`, "PATCH", employee.revision)}>
                <Field label={t("Anzeigename", "Display name")}>
                  <input name="displayName" defaultValue={str(employee, "displayName")} required />
                </Field>
                <Field label="Persona">
                  <textarea name="persona" defaultValue={str(employee, "persona")} rows={4} />
                </Field>
                <Field label={t("Erscheinungsbeschreibung", "Appearance description")}>
                  <textarea name="appearance" defaultValue={str(employee, "appearance")} rows={3} />
                </Field>
                <button disabled={busy}>{t("Crewprofil speichern", "Save crew profile")}</button>
              </form>
            </details>
          ))}
        </section>
      )}
      {step === 2 && <ConfigurationPanel company={company.data} locale={locale} section="models" />}
      {step === 4 && (
        <>
          <p>
            {t(
              "Für einen entfernten Worker wird hier ein echter einmaliger Zugang erstellt. Ohne TLS-Konfiguration bleibt Enrollment gesperrt. Einen lokalen isolierten Ausführungspfad kannst du im Modellzugang konfigurieren; ein eingetragener Pfad belegt noch keine erfolgreiche Isolationsprüfung.",
              "A remote worker receives real one-time credentials here. Enrollment stays blocked without TLS configuration. Configure a local isolated execution path in model access; a saved path does not establish a successful isolation check.",
            )}
          </p>
          <Workers locale={locale} />
        </>
      )}
      {step === 5 && (
        <>
          <p>
            {t(
              "Die folgenden Formulare sind optional. Speichere ausgefüllte Formulare jeweils mit ihrem eigenen Speichern-Button. Zum Fortfahren genügt die Bestätigung unten; leere Formulare kannst du überspringen.",
              "The following forms are optional. Save completed forms using their own save button. To continue, only the confirmation below is required; you can skip empty forms.",
            )}
          </p>
          <section aria-label={t("Bereiche einrichten", "Configure areas")}>
            <h3>{t("Gespeicherte Bereiche", "Saved areas")}</h3>
            <ul>
              {records(areas.data.items).map((area) => (
                <li key={str(area, "id")}>
                  {str(area, "name")} ·{" "}
                  {area.visibility === "private" ? t("Persönlich", "Private") : t("Firma", "Company")}
                </li>
              ))}
            </ul>
            <form onSubmit={(e) => void save(e, "/areas", "POST")}>
              <Field label={t("Neuer Bereich", "New area")}>
                <input name="name" required />
              </Field>
              <Field label={t("Sichtbarkeit", "Visibility")}>
                <select name="visibility">
                  <option value="company">{t("Firma", "Company")}</option>
                  <option value="private">{t("Persönlich", "Private")}</option>
                </select>
              </Field>
              <button disabled={busy}>{t("Bereich anlegen", "Create area")}</button>
            </form>
          </section>
          <ConfigurationPanel company={company.data} locale={locale} section="integrations" />
          <details>
            <summary>
              {t("Kunden und Projekte einrichten (optional)", "Configure customers and projects (optional)")}
            </summary>
            <Entities key={records(areas.data.items).length} locale={locale} />
          </details>
          <Channels company={company.data} locale={locale} />
        </>
      )}
      {step === 6 && (
        <>
          <MandatePanel company={company.data} locale={locale} />
          <SchedulePanel crew={records(crew.data.items)} locale={locale} />
        </>
      )}
      {step === 7 && (
        <section aria-label={t("Tatsächlicher Einrichtungsstand", "Actual setup status")}>
          <h3>{t("Gespeicherter Stand", "Saved state")}</h3>
          <ul>
            <li>
              {t("Gemeinsames Budget", "Company budget")}: {money(budget.data.limitUsdMicros, locale)} ·{" "}
              {str(budget.data, "startsAt")} – {str(budget.data, "endsAt")} ·{" "}
              {budget.data.periodActive
                ? t("Zeitraum aktiv", "Period active")
                : t("Zeitraum nicht aktiv", "Period inactive")}
            </li>
            <li>
              {str(company.data, "name")} · {str(company.data, "timezone")} · {records(crew.data.items).length}{" "}
              {t("Crewprofile", "crew profiles")}
            </li>
            <li>
              {records(areas.data.items).length} {t("Bereiche", "areas")}
            </li>
            <li>
              {configuration.data.openrouter && configuration.data.proton
                ? t("Modellzugang: Verweise konfiguriert", "Model access: references configured")
                : t("Modellzugang fehlt — später ergänzen", "Model access missing — configure later")}{" "}
              · {records(models.data.items).length}{" "}
              {t(
                "Katalogeinträge; kein Nachweis eines erfolgreichen Modellaufrufs",
                "catalog entries; no proof of a successful model call",
              )}
            </li>
            <li>
              {configuration.data.liveExecutionEnabled === true
                ? t(
                    "Live-Ausführung ausdrücklich aktiviert; Budget und Befugnisse gelten weiter",
                    "Live execution explicitly enabled; budgets and authority still apply",
                  )
                : t("Live-Ausführung gesperrt", "Live execution disabled")}
            </li>
            <li>
              {records(workers.data.items).filter((w) => !!w.lastSeenAt && !w.revoked).length}{" "}
              {t("Worker mit bestätigtem Kontakt", "workers with confirmed contact")} ·{" "}
              {configuration.data.isolationProfilePath
                ? t(
                    "Lokaler Isolationspfad konfiguriert, Ausführungsprüfung erforderlich",
                    "Local isolation path configured; execution validation required",
                  )
                : t("Kein lokales Isolationsprofil konfiguriert", "No local isolation profile configured")}
            </li>
            <li>
              {records(configuration.data.connections).length + records(configuration.data.mailConnections).length}{" "}
              {t(
                "Verbindungen konfiguriert; ohne separaten Prüfnachweis nicht live bestätigt",
                "connections configured; not live verified without separate evidence",
              )}
            </li>
            <li>
              {records(mandates.data.items).length} {t("Mandate", "mandates")} · {records(schedules.data.items).length}{" "}
              {t("Routinen", "schedules")}
            </li>
          </ul>
          <p className={styles.muted}>
            {t(
              "Fehlende Zugänge lassen sich in den Einstellungen ergänzen. Einrichtung abschließen startet keinen kostenpflichtigen Einführungsauftrag.",
              "Missing access can be configured in Settings. Completing setup does not start a paid introductory order.",
            )}
          </p>
        </section>
      )}
    </div>
  );
}
