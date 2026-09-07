import ReleaseUpdates from "./ReleaseUpdates.tsx";
import { useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function Maintenance({ locale }: { locale: Locale }) {
  const remote = useRemote("/maintenance"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const policies = records(remote.data.backupPolicies),
    updatePolicies = records(remote.data.updatePolicies),
    activePolicies = policies.filter((policy) => policy.enabled && policy.probeId);
  async function save(path: string, body: Row) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/maintenance${path}`, { method: "POST", body });
      remote.reload();
      setMessage(t("Wartungsstand gespeichert.", "Maintenance state saved."));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <ReleaseUpdates locale={locale} policies={updatePolicies} onChanged={remote.reload} />
      <h3>{t("Geplante Sicherungen und Updates", "Scheduled backups and updates")}</h3>
      <Feedback error={remote.error || error} message={message} />
      <div className={styles.resourceList}>
        {policies.map((policy) => (
          <article className={styles.resource} key={str(policy, "id")}>
            <h4>{str(policy, "name")}</h4>
            <p>
              {policy.enabled
                ? t("Sicherungsplan aktiv", "Backup policy enabled")
                : t("Sicherungsplan nicht aktiv", "Backup policy not enabled")}{" "}
              · {str(policy, "cron")} · {str(policy, "timezone")}
            </p>
            <p>
              {t("Ziel", "Destination")}: {str(policy, "destination")}
            </p>
            <p>
              {policy.probeId
                ? t("Wiederherstellungsprobe liegt vor.", "A restore probe is recorded.")
                : t(
                    "Vor Aktivierung ist eine echte Wiederherstellungsprobe erforderlich.",
                    "A real restore probe is required before activation.",
                  )}
            </p>
            {records(remote.data.probes)
              .filter((probe) => probe.policyId === policy.id)
              .map((probe) => (
                <p key={str(probe, "id")}>
                  {t("Prüfnachweis", "Probe evidence")}: {str(probe, "state")} · {str(probe, "completedAt")}
                </p>
              ))}
            <form
              className={styles.settingsForm}
              onSubmit={(event) => {
                event.preventDefault();
                const f = new FormData(event.currentTarget);
                void save(`/backup-policies/${str(policy, "id")}/probe`, { identityPath: f.get("identityPath") });
              }}
            >
              <Field
                label={`${t("age-Schlüsseldatei für Probe", "age identity file for probe")} · ${str(policy, "name")}`}
              >
                <input name="identityPath" required />
              </Field>
              <p className={styles.muted}>
                {t(
                  "Nur den vorhandenen Dateipfad auf dem Server angeben. Der private Schlüssel wird nicht im Browser eingegeben oder gespeichert.",
                  "Provide the existing server file path only. The private key is not entered or stored in the browser.",
                )}
              </p>
              <button className={styles.secondary} disabled={busy}>
                {t("Sicherung und Wiederherstellungsprobe ausführen", "Run backup and restore probe")}
              </button>
            </form>
            <div className={styles.actions}>
              {!policy.enabled && (
                <button
                  disabled={busy || !policy.probeId}
                  onClick={() => void save(`/backup-policies/${str(policy, "id")}/activate`, {})}
                >
                  {t("Geprüften Sicherungsplan aktivieren", "Activate verified backup policy")}
                </button>
              )}
              {policy.enabled === true && (
                <button
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() => void save(`/backup-policies/${str(policy, "id")}/pause`, {})}
                >
                  {t("Sicherungsplan pausieren", "Pause backup policy")}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <details className={styles.panel}>
        <summary>{t("Neuen Sicherungsplan vorbereiten", "Prepare new backup policy")}</summary>
        <form
          className={styles.settingsForm}
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget);
            void save("/backup-policies", {
              name: f.get("name"),
              cron: f.get("cron"),
              timezone: f.get("timezone"),
              recipient: f.get("recipient"),
              ageExecutable: f.get("ageExecutable"),
              destination: f.get("destination"),
              retention: {
                enabled: f.get("retention") === "on",
                daily: Number(f.get("daily")),
                weekly: Number(f.get("weekly")),
              },
            });
          }}
        >
          <Field label={t("Name des Sicherungsplans", "Backup policy name")}>
            <input name="name" maxLength={120} required />
          </Field>
          <Field label={t("Sicherungszeitplan (Cron, fünf Felder)", "Backup schedule (five-field cron)")}>
            <input name="cron" defaultValue="0 3 * * *" required />
          </Field>
          <Field label={t("Zeitzone des Sicherungsplans", "Backup schedule timezone")}>
            <input name="timezone" defaultValue="Europe/Berlin" required />
          </Field>
          <Field label={t("Öffentlicher age-Schlüssel des Sicherungsplans", "Backup policy public age recipient")}>
            <input name="recipient" pattern="age1[0-9a-z]{20,100}" required />
          </Field>
          <Field label={t("age-Programm des Sicherungsplans", "Backup policy age executable")}>
            <input name="ageExecutable" placeholder="/usr/local/bin/age" required />
          </Field>
          <Field label={t("Sicherungsverzeichnis außerhalb der Firmendaten", "Backup directory outside company data")}>
            <input name="destination" required />
          </Field>
          <label className={styles.check}>
            <input name="retention" type="checkbox" />
            {t(
              "Eigene alte Sicherungsarchive nach dieser Aufbewahrung automatisch bereinigen",
              "Automatically prune owned old backup archives using this retention policy",
            )}
          </label>
          <Field label={t("Tägliche Sicherungen behalten", "Daily backups to retain")}>
            <input name="daily" type="number" min={1} max={365} defaultValue={7} required />
          </Field>
          <Field label={t("Wöchentliche Sicherungen behalten", "Weekly backups to retain")}>
            <input name="weekly" type="number" min={0} max={104} defaultValue={4} required />
          </Field>
          <button disabled={busy}>{t("Sicherungsplan als Entwurf speichern", "Save backup policy draft")}</button>
        </form>
      </details>
      <h4>{t("Archiv- und Auftragsnachweise", "Archive and job evidence")}</h4>
      {records(remote.data.backups).map((archive) => (
        <p key={str(archive, "id")}>
          {str(archive, "archivePath")} · {str(archive, "state")} · {str(archive, "createdAt")}
          <span className={styles.json}>SHA-256: {str(archive, "sha256")}</span>
        </p>
      ))}
      {records(remote.data.backupJobs).map((job) => (
        <p key={str(job, "id")}>
          {str(job, "state")} · {str(job, "finishedAt", str(job, "dueAt"))} · {str(job, "code")}
        </p>
      ))}
      <details className={styles.panel}>
        <summary>
          {t("Updatevertrauen und Wartungsfenster festlegen", "Configure update trust and maintenance window")}
        </summary>
        {!activePolicies.length && (
          <p className={styles.warning}>
            {t(
              "Zuerst einen durch Wiederherstellung geprüften Sicherungsplan aktivieren.",
              "First activate a backup policy verified by a restore probe.",
            )}
          </p>
        )}
        <form
          className={styles.settingsForm}
          onSubmit={(event) => {
            event.preventDefault();
            const f = new FormData(event.currentTarget),
              publicKey = String(f.get("publicKey")).trim();
            if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(publicKey)) {
              setError(t("Nur einen öffentlichen PEM-Schlüssel eingeben.", "Enter a public PEM key only."));
              return;
            }
            void save("/update-policies", {
              name: f.get("name"),
              trustedPublicKeyPem: publicKey,
              installDirectory: f.get("installDirectory"),
              backupPolicyId: f.get("backupPolicyId"),
              allowedClasses: f.getAll("class"),
              autoApplyApproved: f.get("autoApplyApproved") === "on",
              window: { cron: f.get("cron"), timezone: f.get("timezone"), durationMinutes: Number(f.get("duration")) },
            });
          }}
        >
          <Field label={t("Name der Updaterichtlinie", "Update policy name")}>
            <input name="name" required maxLength={120} />
          </Field>
          <Field
            label={t("Vertrauenswürdiger öffentlicher Ed25519-Schlüssel (PEM)", "Trusted public Ed25519 key (PEM)")}
          >
            <textarea name="publicKey" rows={4} required />
          </Field>
          <Field
            label={t(
              "Installationsverzeichnis außerhalb der Firmendaten",
              "Installation directory outside company data",
            )}
          >
            <input name="installDirectory" required />
          </Field>
          <Field label={t("Geprüfter Sicherungsplan für Updates", "Verified backup policy for updates")}>
            <select name="backupPolicyId" required>
              {activePolicies.map((policy) => (
                <option key={str(policy, "id")} value={str(policy, "id")}>
                  {str(policy, "name")}
                </option>
              ))}
            </select>
          </Field>
          <fieldset>
            <legend>{t("Zulässige Änderungsklassen", "Allowed update classes")}</legend>
            {["patch", "minor", "major"].map((kind) => (
              <label className={styles.check} key={kind}>
                <input name="class" type="checkbox" value={kind} />
                {kind}
              </label>
            ))}
          </fieldset>
          <label className={styles.check}>
            <input name="autoApplyApproved" type="checkbox" />
            {t(
              "Bereits konkret freigegebene Updates im Wartungsfenster automatisch anwenden",
              "Automatically apply explicitly approved updates in the maintenance window",
            )}
          </label>
          <p className={styles.muted}>
            {t(
              "Jedes Release benötigt weiterhin deine konkrete Freigabe. Diese läuft nach 24 Stunden ab; die Automatik verlängert sie nicht.",
              "Every release still needs your explicit approval. It expires after 24 hours; scheduling does not extend it.",
            )}
          </p>
          <Field label={t("Wartungsfenster (Cron, fünf Felder)", "Maintenance window (five-field cron)")}>
            <input name="cron" defaultValue="0 4 * * 0" required />
          </Field>
          <Field label={t("Zeitzone des Wartungsfensters", "Maintenance window timezone")}>
            <input name="timezone" defaultValue="Europe/Berlin" required />
          </Field>
          <Field label={t("Dauer des Wartungsfensters in Minuten", "Maintenance window duration in minutes")}>
            <input name="duration" type="number" min={1} max={240} defaultValue={60} required />
          </Field>
          <button disabled={busy || !activePolicies.length}>
            {t("Updaterichtlinie speichern", "Save update policy")}
          </button>
        </form>
      </details>
      <div className={styles.resourceList}>
        {updatePolicies.map((policy) => (
          <article className={styles.resource} key={str(policy, "id")}>
            <h4>{str(policy, "name")}</h4>
            <p>
              {str(policy, "installDirectory")} ·{" "}
              {Array.isArray(policy.allowedClasses) ? policy.allowedClasses.join(", ") : ""}
            </p>
            <p>
              {policy.revoked ? t("Widerrufen", "Revoked") : t("Vertrauensregel gespeichert", "Trust rule recorded")}
            </p>
            {!policy.revoked && (
              <button
                className={styles.secondary}
                disabled={busy}
                onClick={() => void save(`/update-policies/${str(policy, "id")}/revoke`, {})}
              >
                {t("Updatevertrauen widerrufen", "Revoke update trust")}
              </button>
            )}
          </article>
        ))}
      </div>
      <form
        className={styles.settingsForm}
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void save("/updates", { policyId: f.get("policyId"), releaseDirectory: f.get("releaseDirectory") });
        }}
      >
        <h4>{t("Konkretes Update prüfen", "Inspect a specific update")}</h4>
        <Field label={t("Vertrauensregel für das Update", "Trust policy for update")}>
          <select name="policyId" required>
            {updatePolicies
              .filter((policy) => !policy.revoked)
              .map((policy) => (
                <option key={str(policy, "id")} value={str(policy, "id")}>
                  {str(policy, "name")}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("Verzeichnis des signierten Releasepakets", "Signed release package directory")}>
          <input name="releaseDirectory" required />
        </Field>
        <button disabled={busy || !updatePolicies.some((policy) => !policy.revoked)}>
          {t("Release prüfen und Updateplan anlegen", "Verify release and create update plan")}
        </button>
      </form>
      {records(remote.data.updatePlans).map((plan) => (
        <article className={styles.panel} key={str(plan, "id")}>
          <h4>
            {str(plan, "fromVersion")} → {str(plan, "toVersion")} · {str(plan, "updateClass")}
          </h4>
          <p>
            {t("Status", "Status")}: {str(plan, "state")} · {str(plan, "errorCode")}
          </p>
          <p className={styles.json}>SHA-256: {str(plan, "manifestSha256")}</p>
          {Boolean(plan.expiresAt) && (
            <p>
              {t("Freigabe gültig bis", "Approval expires")}: {str(plan, "expiresAt")}
            </p>
          )}
          {records(remote.data.updateScheduleAttempts)
            .filter((attempt) => attempt.planId === plan.id)
            .map((attempt) => (
              <p key={str(attempt, "attemptedAt")} role="status">
                {t("Automatische Anwendung", "Scheduled application")}: {str(attempt, "state")} {str(attempt, "code")}
                {attempt.retryNotBefore
                  ? ` · ${t("Nächster Versuch ab", "Retry after")}: ${str(attempt, "retryNotBefore")}`
                  : ""}
              </p>
            ))}
          {plan.state === "planned" && (
            <button disabled={busy} onClick={() => void save(`/updates/${str(plan, "id")}/approve`, {})}>
              {t("Dieses konkrete Update freigeben", "Approve this specific update")}
            </button>
          )}
          {plan.state === "approved" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save(`/updates/${str(plan, "id")}/apply`, {});
              }}
            >
              <p>
                {t(
                  "Die Aktivierung benötigt das genehmigte Wartungsfenster, eine bestätigte Sicherung und die serverseitige Lebenszyklusprüfung.",
                  "Activation requires the approved maintenance window, a verified backup and server lifecycle checks.",
                )}
              </p>
              <label className={styles.check}>
                <input type="checkbox" required />
                {t("Dieses freigegebene Release jetzt anwenden", "Apply this approved release now")}
              </label>
              <button disabled={busy}>{t("Update anwenden", "Apply update")}</button>
            </form>
          )}
          {plan.state === "effect_unknown" && (
            <p className={styles.warning}>
              {t(
                "Wirkung ungeklärt. Kein blinder Wiederholungsversuch verfügbar.",
                "Effect unknown. Blind retry is unavailable.",
              )}
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
