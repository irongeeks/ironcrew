import { useEffect, useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
type Intent = { operation: string; input: Row; state: string };
const terminal = ["succeeded", "failed", "denied", "expired"];
function fromAction(action: Row): Intent {
  const args = (action.args ?? {}) as Row,
    operation =
      action.toolId === "incident.repair"
        ? "repair"
        : action.toolId === "incident.check"
          ? "check"
          : "customer-message";
  return {
    operation,
    state: str(action, "status"),
    input: {
      actionId: action.id,
      mandateId: action.mandateId,
      mandateVersion: action.mandateVersion,
      targetId: args.targetId ?? action.targetId,
      ...(operation === "check"
        ? { healthProfileSha256: args.healthProfileSha256 }
        : { targetConfigSha256: args.targetConfigSha256 }),
      ...(operation === "customer-message"
        ? { to: args.to, subject: args.subject, content: args.content, incidentState: args.incidentState }
        : {}),
    },
  };
}
function MandateChoice({ items, label, placeholder }: { items: Row[]; label: string; placeholder: string }) {
  return (
    <Field label={label}>
      <select name="mandateId" required>
        <option value="">{placeholder}</option>
        {items.map((m) => (
          <option key={str(m, "id")} value={str(m, "id")}>
            {str(m, "id")} · {str(m, "expiresAt")}
          </option>
        ))}
      </select>
    </Field>
  );
}
export default function IncidentOperations({
  base,
  locale,
  onChange,
}: {
  base: string;
  locale: Locale;
  onChange: () => void;
}) {
  const t = (de: string, en: string) => (locale === "de" ? de : en),
    status = useRemote(`${base}/incident/status`),
    order = useRemote(base),
    configuration = useRemote("/configuration"),
    mandates = useRemote("/mandates");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [mailId, setMailId] = useState("");
  const storageKey = `ironcrew:incident:${base}`,
    [local, setLocal] = useState<Intent | null>(() => {
      try {
        return JSON.parse(localStorage.getItem(storageKey) ?? "null");
      } catch {
        return null;
      }
    });
  const incident = (status.data.incident ?? {}) as Row,
    observation = (status.data.observation ?? {}) as Row,
    profile = (status.data.healthProfile ?? {}) as Row,
    scope = (order.data.scope ?? {}) as Row;
  const targets = records(status.data.serviceTargets),
    mails = records(status.data.mailTargets),
    target = targets.find((target) => target.id === incident.targetId),
    mail = mails.find((mail) => mail.id === mailId),
    actions = records(status.data.pendingActions);
  const live = configuration.data.liveExecutionEnabled === true;
  const server =
      actions.find((action) => action.id === local?.input.actionId) ??
      actions.find((action) => !terminal.includes(str(action, "status"))),
    intent = server ? fromAction(server) : local;
  useEffect(() => {
    if (observation.state !== "active") return;
    const timer = setInterval(() => status.reload(), 5000);
    return () => clearInterval(timer);
  }, [observation.state, base]);
  const eligible = (tool: string, targetId: unknown) =>
    records(mandates.data.items).filter((m) => {
      const s = (m.scope ?? {}) as Row;
      return (
        !m.revokedAt &&
        Date.parse(str(m, "expiresAt")) > Date.now() &&
        ["companyId", "areaId", "customerId", "projectId"].every((k) => s[k] === scope[k]) &&
        Array.isArray(m.allowedToolIds) &&
        m.allowedToolIds.includes(tool) &&
        Array.isArray(m.targetIds) &&
        m.targetIds.includes(targetId)
      );
    });
  function hold(value: Intent | null) {
    setLocal(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      /* Retain in-memory state. */
    }
  }
  async function save(path: string, body: Row, method = "POST", revision?: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request(path, { method, body, revision });
      status.reload();
      mandates.reload();
      onChange();
      setMessage(
        t(
          "Vorgang gespeichert. Der angezeigte Nachweis bestimmt den tatsächlichen Stand.",
          "Action recorded. The evidence shown determines the actual state.",
        ),
      );
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function execute(value: Intent) {
    setBusy(true);
    try {
      const latest = await request(`${base}/incident/status`),
        stored = records(latest.pendingActions).find((a) => a.id === value.input.actionId);
      if (stored) value = fromAction(stored);
      if (["effect_unknown", "running", "dispatched"].includes(value.state)) {
        hold(value);
        status.reload();
        setBusy(false);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }
    hold(value);
    const result = await save(`${base}/incident/${value.operation}`, value.input);
    hold({ ...value, state: result ? str(result, "state", "unconfirmed") : "unconfirmed" });
  }
  function start(operation: string, input: Row, mandateId: unknown) {
    const m = records(mandates.data.items).find((m) => m.id === mandateId);
    if (!m) return;
    void execute({
      operation,
      state: "proposed",
      input: { actionId: crypto.randomUUID(), mandateId: m.id, mandateVersion: m.version, ...input },
    });
  }
  return (
    <section
      className={styles.panel}
      aria-label={t("Reparatur, Prüfung und Kundeninformation", "Repair, verification and customer communication")}
    >
      <h3>{t("Reparatur, Prüfung und Kundeninformation", "Repair, verification and customer communication")}</h3>
      <Feedback error={error || status.error} message={message} />
      {!live && (
        <p className={styles.warning}>
          {t(
            "Live-Ausführung ist nicht aktiviert. Prüfprofile können vorbereitet werden; Dienstaktionen und Versand bleiben gesperrt.",
            "Live execution is not enabled. Check profiles can be prepared; service actions and sending remain blocked.",
          )}{" "}
          <a href="/settings/models">{t("Ausführung konfigurieren", "Configure execution")}</a>
        </p>
      )}
      <p>
        {t("Belegter Vorfallstand", "Recorded incident state")}: {str(incident, "state", "—")}
      </p>
      {!target && (
        <p className={styles.warning}>
          {t(
            "Für dieses Ziel ist kein administrierter Dienstbroker eingerichtet. Es kann keine Reparatur freigegeben werden.",
            "No administrative service broker is configured for this target. Repair approval is unavailable.",
          )}
        </p>
      )}
      {target && (
        <>
          <p>
            {t("Festes Reparaturziel", "Fixed repair target")}: {str(target, "kind")} · {str(target, "resourceName")}
            <span className={styles.json}>SHA-256: {str(target, "configSha256")}</span>
          </p>
          <details>
            <summary>
              {t("Unabhängige Funktionsprüfung konfigurieren", "Configure independent functional check")}
            </summary>
            <form
              className={styles.settingsForm}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget),
                  input = {
                    targetId: target.id,
                    scope,
                    url: f.get("url"),
                    expectedStatus: Number(f.get("expectedStatus")),
                    contains: String(f.get("contains"))
                      .split("\n")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    observationSeconds: Number(f.get("observationSeconds")),
                    checkIntervalSeconds: Number(f.get("checkIntervalSeconds")),
                    maxCheckGapSeconds: Number(f.get("maxCheckGapSeconds")),
                    timeoutMs: Number(f.get("timeoutMs")),
                    ...(f.get("ca") ? { trustedCaPem: f.get("ca") } : {}),
                  };
                if (
                  input.checkIntervalSeconds > input.maxCheckGapSeconds ||
                  input.maxCheckGapSeconds >= input.observationSeconds
                ) {
                  setError(
                    t(
                      "Prüfabstand ≤ maximale Prüflücke < Beobachtungsdauer erforderlich.",
                      "Check interval ≤ maximum check gap < observation duration is required.",
                    ),
                  );
                  return;
                }
                void save(
                  `/incident/health-profiles${profile.revision ? `/${str(target, "id")}` : ""}`,
                  input,
                  profile.revision ? "PUT" : "POST",
                  profile.revision,
                );
              }}
            >
              <Field label={t("URL der unabhängigen Funktionsprüfung", "Independent functional check URL")}>
                <input name="url" type="url" pattern="https?://.*" defaultValue={str(profile, "url")} required />
              </Field>
              <Field label={t("Erwarteter HTTP-Status", "Expected HTTP status")}>
                <input
                  name="expectedStatus"
                  type="number"
                  min={200}
                  max={299}
                  defaultValue={Number(profile.expectedStatus ?? 200)}
                  required
                />
              </Field>
              <Field label={t("Erwartete Inhalte (einer je Zeile)", "Expected contents (one per line)")}>
                <textarea
                  name="contains"
                  defaultValue={Array.isArray(profile.contains) ? profile.contains.join("\n") : ""}
                  required
                />
              </Field>
              <Field label={t("Beobachtungsdauer in Sekunden", "Observation duration in seconds")}>
                <input
                  name="observationSeconds"
                  type="number"
                  min={2}
                  max={86400}
                  defaultValue={Number(profile.observationSeconds ?? 600)}
                  required
                />
              </Field>
              <Field label={t("Prüfabstand in Sekunden", "Check interval in seconds")}>
                <input
                  name="checkIntervalSeconds"
                  type="number"
                  min={1}
                  max={300}
                  defaultValue={Number(profile.checkIntervalSeconds ?? 30)}
                  required
                />
              </Field>
              <Field label={t("Maximale Prüflücke in Sekunden", "Maximum check gap in seconds")}>
                <input
                  name="maxCheckGapSeconds"
                  type="number"
                  min={1}
                  max={600}
                  defaultValue={Number(profile.maxCheckGapSeconds ?? 60)}
                  required
                />
              </Field>
              <Field label={t("Zeitlimit je HTTP-Prüfung (Millisekunden)", "HTTP check timeout (milliseconds)")}>
                <input
                  name="timeoutMs"
                  type="number"
                  min={100}
                  max={30000}
                  defaultValue={Number(profile.timeoutMs ?? 5000)}
                  required
                />
              </Field>
              <Field
                label={t(
                  "Öffentliches CA-Zertifikat für Funktionsprüfung (optional)",
                  "Public CA certificate for functional check (optional)",
                )}
              >
                <textarea name="ca" defaultValue={str(profile, "trustedCaPem")} />
              </Field>
              <button disabled={busy}>{t("Prüfprofil versioniert speichern", "Save versioned check profile")}</button>
            </form>
          </details>
          <form
            className={styles.settingsForm}
            onSubmit={(e) => {
              e.preventDefault();
              start(
                "repair",
                { targetId: target.id, targetConfigSha256: target.configSha256 },
                new FormData(e.currentTarget).get("mandateId"),
              );
            }}
          >
            <h4>{t("Konkreten Dienstneustart freigeben lassen", "Request approval for exact service restart")}</h4>
            <MandateChoice
              items={eligible("incident.repair", target.id)}
              placeholder={t("Passendes Mandat auswählen", "Select matching mandate")}
              label={t("Reparaturmandat", "Repair mandate")}
            />
            <p>
              {t(
                "Die Freigabe bindet dieses Dienstziel und dessen Konfiguration. Ein Neustart bestätigt noch keine behobene Störung.",
                "Approval binds this service target and its configuration. A restart does not establish that the incident is resolved.",
              )}
            </p>
            <label className={styles.check}>
              <input type="checkbox" required />
              {t("Konkretes Ziel und Neustartwirkung geprüft.", "Exact target and restart effect reviewed.")}
            </label>
            <button disabled={!live || busy || !!intent || !eligible("incident.repair", target.id).length}>
              {t("Reparaturfreigabe anfordern", "Request repair approval")}
            </button>
          </form>
          <form
            className={styles.settingsForm}
            onSubmit={(e) => {
              e.preventDefault();
              start(
                "check",
                { targetId: target.id, healthProfileSha256: profile.fingerprint },
                new FormData(e.currentTarget).get("mandateId"),
              );
            }}
          >
            <h4>{t("Unabhängig prüfen und beobachten", "Check independently and observe")}</h4>
            <p>
              {profile.url
                ? `${str(profile, "url")} · ${profile.observationSeconds} s`
                : t("Zuerst ein unabhängiges Prüfprofil speichern.", "Save an independent check profile first.")}
            </p>
            <MandateChoice
              items={eligible("incident.check", target.id)}
              placeholder={t("Passendes Mandat auswählen", "Select matching mandate")}
              label={t("Prüf- und Beobachtungsmandat", "Check and observation mandate")}
            />
            <p>
              {t(
                "Mandat und Ablaufzeit müssen das vollständige Beobachtungsfenster abdecken. Tatsächliche HTTP-Prüfungen, Ausfälle und Prüflücken bestimmen das Ergebnis.",
                "Mandate duration and expiry must cover the complete observation window. Actual HTTP checks, failures and check gaps determine the outcome.",
              )}
            </p>
            <button
              disabled={
                !live ||
                busy ||
                !!intent ||
                !profile.fingerprint ||
                observation.state === "active" ||
                !eligible("incident.check", target.id).length
              }
            >
              {t("Reale Funktionsprüfung starten", "Start actual functional check")}
            </button>
          </form>
        </>
      )}
      {typeof observation.state === "string" && (
        <div className={styles.panel}>
          <h4>{t("Beobachtungsnachweis", "Observation evidence")}</h4>
          <p>{str(observation, "state")}</p>
          {[
            ["lastCheckAt", t("Letzte Prüfung", "Last check")],
            ["nextCheckAt", t("Nächste Prüfung", "Next check")],
            ["endsAt", t("Ende des Beobachtungsfensters", "Observation window ends")],
            ["reason", t("Offener Grund", "Open reason")],
          ].map(([key, label]) => (
            <p key={key}>
              {label}: {str(observation, key!, "—")}
            </p>
          ))}
          <button className={styles.secondary} disabled={status.loading} onClick={() => status.reload()}>
            {t("Beobachtungsstand aktualisieren", "Refresh observation status")}
          </button>
        </div>
      )}
      <details>
        <summary>{t("Kundeninformation vorbereiten", "Prepare customer communication")}</summary>
        {!mails.length && (
          <p>
            {t(
              "Kein eingerichtetes TLS-Postfach mit Versandbefugnis in diesem Bereich.",
              "No configured TLS mailbox with send permission in this scope.",
            )}
          </p>
        )}
        <form
          className={styles.settingsForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!mail) return;
            const f = new FormData(e.currentTarget);
            start(
              "customer-message",
              {
                targetId: mail.id,
                targetConfigSha256: mail.configSha256,
                to: f.get("to"),
                subject: f.get("subject"),
                content: f.get("content"),
                incidentState: incident.state,
              },
              f.get("mandateId"),
            );
          }}
        >
          <Field label={t("Absenderpostfach der Kundeninformation", "Sender mailbox for customer communication")}>
            <select value={mailId} onChange={(e) => setMailId(e.target.value)} required>
              <option value="">{t("Postfach auswählen", "Select mailbox")}</option>
              {mails.map((m) => (
                <option key={str(m, "id")} value={str(m, "id")}>
                  {str(m, "from")} · {str(m, "host")}
                </option>
              ))}
            </select>
          </Field>
          {mail && (
            <p className={styles.json}>
              {t("Postfachziel für das Mandat", "Mailbox target for the mandate")}: {str(mail, "id")}
              <br />
              SHA-256: {str(mail, "configSha256")}
            </p>
          )}
          <Field label={t("Kunden-E-Mail-Adresse", "Customer email address")}>
            <input name="to" type="email" required />
          </Field>
          <Field label={t("Betreff der Kundeninformation", "Customer communication subject")}>
            <input name="subject" maxLength={200} required />
          </Field>
          <Field label={t("Exakter Nachrichtentext an den Kunden", "Exact customer message")}>
            <textarea name="content" rows={6} maxLength={100000} required />
          </Field>
          <p>
            {t("An diese Meldung gebundener Vorfallstand", "Incident state bound to this message")}:{" "}
            {str(incident, "state", "—")}
          </p>
          <MandateChoice
            items={eligible("incident.customer_message", mailId)}
            placeholder={t("Passendes Mandat auswählen", "Select matching mandate")}
            label={t("Mandat für Kundeninformation", "Customer communication mandate")}
          />
          <label className={styles.check}>
            <input type="checkbox" required />
            {t(
              "Empfänger und exakten Text geprüft; eigene Versandfreigabe anfordern.",
              "Recipient and exact text reviewed; request separate send approval.",
            )}
          </label>
          <p>
            {t(
              "Eine SMTP-Annahme wird als Annahme ausgewiesen, nicht als bestätigte Zustellung.",
              "SMTP acceptance is recorded as acceptance, not confirmed delivery.",
            )}
          </p>
          <button
            disabled={!live || busy || !!intent || !mail || !eligible("incident.customer_message", mailId).length}
          >
            {t("Kundenmailfreigabe anfordern", "Request customer email approval")}
          </button>
        </form>
      </details>
      <p>
        <a href="/settings/mandates">
          {t(
            "Konkrete Mandate für Dienstziel oder Postfach erteilen",
            "Issue concrete mandates for the service target or mailbox",
          )}
        </a>
      </p>
      {intent && (
        <div className={styles.panel}>
          <p>
            {t("Gespeicherte Vorfallaktion", "Saved incident action")}: {intent.operation} · {intent.state}
          </p>
          <span className={styles.json}>{str(intent.input, "actionId")}</span>
          <a href="/decisions">
            {t("Vorfallfreigabe in Entscheidungen prüfen", "Review incident approval in Decisions")}
          </a>
          {["proposed", "approved", "approval", "unconfirmed"].includes(intent.state) && (
            <button disabled={busy} onClick={() => void execute(intent)}>
              {t(
                "Dieselbe Vorfallaktion nach Entscheidung fortsetzen",
                "Resume the same incident action after decision",
              )}
            </button>
          )}
          {intent.state === "effect_unknown" && (
            <p className={styles.warning}>
              {t(
                "Wirkung ungeklärt. Keine neue Ausführung; Systemzustand zuerst administrativ abgleichen.",
                "Effect unknown. Do not execute again; reconcile system state first.",
              )}
            </p>
          )}
          {terminal.includes(intent.state) && (
            <button className={styles.secondary} onClick={() => hold(null)}>
              {t("Abgeschlossene Vorfallaktion ausblenden", "Dismiss finished incident action")}
            </button>
          )}
        </div>
      )}
      <details>
        <summary>{t("Nachweise der Vorfallaktionen", "Incident action evidence")}</summary>
        {actions.map((action) => (
          <p key={str(action, "id")}>
            {str(action, "toolId")} · {str(action, "status")}
            <span className={styles.json}>{str(action, "id")}</span>
          </p>
        ))}
      </details>
    </section>
  );
}
