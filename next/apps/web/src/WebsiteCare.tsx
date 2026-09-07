import { useState, type FormEvent } from "react";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import { request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
const dollars = (value: unknown) => (Number(value ?? 0) / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
const micros = (value: FormDataEntryValue | null) => {
  const normalized = String(value).replace(",", ".");
  if (!/^\d+(\.\d{1,6})?$/.test(normalized)) throw new Error("USD: maximal sechs Nachkommastellen");
  const [whole, fraction = ""] = normalized.split(".");
  return (BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"))).toString();
};
const localTime = (value: unknown) => {
  if (!value) return "";
  const date = new Date(String(value));
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const keys = [
  "profileId",
  "deploymentId",
  "mandateId",
  "mandateVersion",
  "enabled",
  "expiresAt",
  "budgetLimitUsdMicros",
  "healthIntervalSeconds",
  "incidentBudgetLimitUsdMicros",
  "backup",
  "update",
];
const payload = (p: Row) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
export default function WebsiteCare({ base, locale }: { base: string; locale: Locale }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en),
    care = useRemote(`${base}/website-care`),
    hosting = useRemote(`${base}/hosting`),
    mandates = useRemote("/mandates");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [editing, setEditing] = useState<Row | null>(null),
    [update, setUpdate] = useState(false);
  const deployments = records(hosting.data.deployments).filter((d) => d.state === "verified"),
    policies = records(care.data.policies);
  async function send(url: string, body: Row, revision?: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request(url, { method: revision ? "PUT" : "POST", revision, body });
      if (["failed", "effect_unknown", "rolled_back"].includes(str(result, "state")))
        setError(str(result, "errorCode", str(result, "state")));
      care.reload();
      setMessage(
        t(
          "Betreuung gespeichert. Nur bestehende Befugnisse gelten.",
          "Care recorded. Existing authority remains the limit.",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget),
      deployment = deployments.find((d) => d.id === f.get("deploymentId"));
    if (!deployment) return;
    const mandate = records(mandates.data.items).find((d) => d.id === f.get("mandateId"));
    const schedule = (prefix: string) => ({ cron: f.get(prefix + "Cron"), timezone: f.get("timezone") });
    await send(
      editing ? `${base}/website-care/${str(editing, "id")}` : `${base}/website-care`,
      {
        profileId: deployment.profileId,
        deploymentId: deployment.id,
        mandateId: f.get("mandateId"),
        mandateVersion: Number(mandate?.version ?? 1),
        enabled: f.get("enabled") === "on",
        expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
        budgetLimitUsdMicros: micros(f.get("budget")),
        healthIntervalSeconds: Number(f.get("interval")),
        incidentBudgetLimitUsdMicros: micros(f.get("incidentBudget")),
        backup: {
          destinationId: f.get("destination"),
          recipient: f.get("recipient"),
          retentionDays: Number(f.get("retention")),
          costUsdMicros: micros(f.get("backupCost")),
          schedule: schedule("backup"),
        },
        ...(update
          ? {
              update: {
                candidate: {
                  class: "patch",
                  currentVersion: f.get("currentVersion"),
                  currentManifestSha256: f.get("currentHash"),
                  version: f.get("version"),
                  manifestSha256: f.get("hash"),
                  costUsdMicros: micros(f.get("updateCost")),
                },
                schedule: schedule("update"),
                windowMinutes: Number(f.get("windowMinutes")),
              },
            }
          : {}),
      },
      editing?.revision,
    );
  }
  const backup = (editing?.backup ?? {}) as Row,
    updateRow = (editing?.update ?? {}) as Row,
    candidate = (updateRow.candidate ?? {}) as Row;
  return (
    <section className={styles.panel}>
      <h3>{t("Technische Websitebetreuung", "Technical website care")}</h3>
      <p>
        {t(
          "Für gehostete Websites vorgesehen: Erreichbarkeit, verschlüsselte Sicherungen mit Wiederherstellungsprobe und konkret freigegebene Sicherheitsupdates. Ohne bestätigtes Mandat startet nichts. Inhalte und SEO benötigen eigene Aufträge; dies ist keine IronCrew-Firmensicherung.",
          "For hosted websites: availability, encrypted backups with restore probes and explicitly authorized security updates. No dispatch without a confirmed mandate. Content and SEO require separate orders; this is not an IronCrew company backup.",
        )}
      </p>
      <Feedback error={error || care.error} message={message} />
      {!deployments.length ? (
        <p>
          {t(
            "Zuerst eine Veröffentlichung mit bestätigter Liveprüfung auswählen.",
            "First provide a deployment with verified live checks.",
          )}
        </p>
      ) : (
        <details>
          <summary>
            {editing
              ? t("Betreuungsmandat ändern", "Revise care policy")
              : t("Betreuungsmandat einrichten", "Configure care policy")}
          </summary>
          <form
            key={str(editing ?? {}, "id", "new")}
            onSubmit={(e) => void save(e).catch((error: Error) => setError(error.message))}
          >
            <Field label={t("Geprüftes Deployment", "Verified deployment")}>
              <select name="deploymentId" defaultValue={str(editing ?? {}, "deploymentId")} required>
                {deployments.map((d) => (
                  <option key={str(d, "id")} value={str(d, "id")}>
                    {str(d, "artifactVersionId")} · {str(d, "id")}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("Technisches Mandat (care.check/backup/update)", "Technical mandate (care.check/backup/update)")}
            >
              <select name="mandateId" defaultValue={str(editing ?? {}, "mandateId")} required>
                <option value="">{t("Mandat auswählen", "Select mandate")}</option>
                {records(mandates.data.items).map((m) => (
                  <option key={str(m, "id")} value={str(m, "id")}>
                    {str(m, "id")} v{Number(m.version ?? 1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Mandat gültig bis", "Care valid until")}>
              <input name="expiresAt" type="datetime-local" defaultValue={localTime(editing?.expiresAt)} required />
            </Field>
            <Field label={t("Gesamtrahmen in USD", "Total limit in USD")}>
              <input
                name="budget"
                inputMode="decimal"
                pattern="[0-9]+([.,][0-9]{1,6})?"
                defaultValue={dollars(editing?.budgetLimitUsdMicros)}
                required
              />
            </Field>
            <Field label={t("Vorfallbudget in USD", "Incident limit in USD")}>
              <input
                name="incidentBudget"
                inputMode="decimal"
                pattern="[0-9]+([.,][0-9]{1,6})?"
                defaultValue={dollars(editing?.incidentBudgetLimitUsdMicros)}
                required
              />
            </Field>
            <Field label={t("Erreichbarkeitsintervall in Sekunden", "Health interval in seconds")}>
              <input
                name="interval"
                type="number"
                min={30}
                max={86400}
                defaultValue={Number(editing?.healthIntervalSeconds ?? 300)}
                required
              />
            </Field>
            <Field label={t("IANA-Zeitzone", "IANA timezone")}>
              <input
                name="timezone"
                defaultValue={str((backup.schedule ?? {}) as Row, "timezone", "Europe/Berlin")}
                required
              />
            </Field>
            <Field label={t("Sicherungszeitplan (Cron)", "Backup schedule (cron)")}>
              <input
                name="backupCron"
                defaultValue={str((backup.schedule ?? {}) as Row, "cron", "0 2 * * *")}
                required
              />
            </Field>
            <Field
              label={t(
                "Freigegebene Sicherungsziel-ID beim Hostingbroker",
                "Approved backup destination ID at hosting broker",
              )}
            >
              <input name="destination" defaultValue={str(backup, "destinationId")} required />
            </Field>
            <Field label={t("Öffentlicher age-Empfänger", "Public age recipient")}>
              <input name="recipient" defaultValue={str(backup, "recipient")} pattern="age1[0-9a-z]{20,100}" required />
            </Field>
            <Field label={t("Aufbewahrung in Tagen", "Retention in days")}>
              <input
                name="retention"
                type="number"
                min={1}
                max={3650}
                defaultValue={Number(backup.retentionDays ?? 7)}
                required
              />
            </Field>
            <Field label={t("Bestätigte Backupkosten in USD", "Confirmed backup cost in USD")}>
              <input
                name="backupCost"
                pattern="[0-9]+([.,][0-9]{1,6})?"
                defaultValue={dollars(backup.costUsdMicros)}
                required
              />
            </Field>
            <label className={styles.check}>
              <input type="checkbox" checked={update} onChange={(e) => setUpdate(e.target.checked)} />
              {t(
                "Eine konkrete Patchversion mit Rückweg freigeben",
                "Authorize one concrete patch version and rollback",
              )}
            </label>
            {update && (
              <fieldset>
                <legend>{t("Versionsgebundene Updatefreigabe", "Version-bound update authorization")}</legend>
                {[
                  ["currentVersion", t("Aktuelle Laufzeitversion", "Current runtime version"), "currentVersion"],
                  ["currentHash", t("Aktueller Manifest-SHA256", "Current manifest SHA256"), "currentManifestSha256"],
                  ["version", t("Neue Patchversion", "New patch version"), "version"],
                  ["hash", t("Neuer Manifest-SHA256", "New manifest SHA256"), "manifestSha256"],
                  ["updateCost", t("Bestätigte Updatekosten in USD", "Confirmed update cost in USD"), "costUsdMicros"],
                ].map(([name, label, key]) => (
                  <Field key={name} label={label!}>
                    <input
                      name={name}
                      defaultValue={key === "costUsdMicros" ? dollars(candidate[key]) : str(candidate, key!)}
                      required
                    />
                  </Field>
                ))}
                <Field label={t("Wartungsfenster in Minuten", "Maintenance window in minutes")}>
                  <input
                    name="windowMinutes"
                    type="number"
                    min={1}
                    max={360}
                    defaultValue={Number(updateRow.windowMinutes ?? 30)}
                    required
                  />
                </Field>
                <Field label={t("Wartungsfenster (Cron)", "Maintenance schedule (cron)")}>
                  <input
                    name="updateCron"
                    defaultValue={str((updateRow.schedule ?? {}) as Row, "cron", "0 3 * * 1")}
                    required
                  />
                </Field>
              </fieldset>
            )}
            <label className={styles.check}>
              <input name="enabled" type="checkbox" defaultChecked={editing?.enabled === true} />
              {t("Diese genaue technische Betreuung aktivieren", "Enable this exact technical care policy")}
            </label>
            <button disabled={busy}>{t("Betreuungsmandat bestätigen", "Confirm care policy")}</button>
          </form>
        </details>
      )}
      {policies.map((p) => (
        <article key={str(p, "id")}>
          <h4>{p.enabled ? t("Betreuung aktiviert", "Care enabled") : t("Betreuung pausiert", "Care paused")}</h4>
          <p>
            <a href={`/orders/${str(p, "careOrderId")}`}>
              {t("Eigenen Betreuungsauftrag öffnen", "Open separate care order")}
            </a>
          </p>
          <button
            disabled={busy}
            className={styles.secondary}
            onClick={() => {
              setEditing(p);
              setUpdate(Boolean(p.update));
            }}
          >
            {t("Befugnisse bearbeiten", "Edit authority")}
          </button>
          <button
            disabled={busy}
            className={styles.secondary}
            onClick={() =>
              void send(`${base}/website-care/${str(p, "id")}`, { ...payload(p), enabled: !p.enabled }, p.revision)
            }
          >
            {p.enabled
              ? t("Automatik pausieren", "Pause automation")
              : t("Genau dieses Mandat aktivieren", "Enable this exact policy")}
          </button>
          {p.enabled === true &&
            ["check", "backup", ...(p.update ? ["update"] : [])].map((kind) => (
              <button
                key={kind}
                disabled={busy}
                className={styles.secondary}
                onClick={() => void send(`${base}/website-care/${str(p, "id")}/run`, { kind })}
              >
                {kind === "check"
                  ? t("Erreichbarkeit prüfen", "Check availability")
                  : kind === "backup"
                    ? t("Sicherung mit Probe starten", "Run backup and restore probe")
                    : t("Freigegebenen Patch anwenden", "Apply authorized patch")}
              </button>
            ))}
        </article>
      ))}
      {records(care.data.jobs).map((j) => (
        <article key={str(j, "id")}>
          <p>
            {str(j, "kind")} · {str(j, "state")} · {str(j, "startedAt")}
          </p>
          {Boolean(j.errorCode) && <p role="alert">{str(j, "errorCode")}</p>}
          {Boolean(j.incidentOrderId) && (
            <a href={`/orders/${str(j, "incidentOrderId")}`}>
              {t("Verknüpften Vorfall prüfen", "Review linked incident")}
            </a>
          )}
        </article>
      ))}
    </section>
  );
}
