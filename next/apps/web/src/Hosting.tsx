import { useState } from "react";
import { request, string as str, money, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
type Intent = { operation: string; input: Row; state: string };
export default function Hosting({
  base,
  workflow,
  locale,
  onChange,
}: {
  base: string;
  workflow: Row;
  locale: Locale;
  onChange: () => void;
}) {
  const t = (de: string, en: string) => (locale === "de" ? de : en),
    order = useRemote(base),
    profiles = useRemote("/hosting/profiles"),
    status = useRemote(`${base}/hosting`),
    mandates = useRemote("/mandates"),
    artifacts = useRemote(`${base}/artifacts`);
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [anonymous, setAnonymous] = useState(false);
  const storageKey = `ironcrew:hosting:${base}`;
  const [localIntent, setIntent] = useState<Intent | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "null");
    } catch {
      return null;
    }
  });
  function fromAction(action: Row): Intent {
    const args = (action.args ?? {}) as Row,
      operation =
        action.toolId === "hosting.provision"
          ? "provision"
          : action.toolId === "website.publish"
            ? "publish"
            : "rollback";
    return {
      operation,
      state: str(action, "status"),
      input: {
        actionId: action.id,
        profileId: args.profileId ?? action.targetId,
        mandateId: action.mandateId,
        mandateVersion: action.mandateVersion,
        ...(operation === "publish"
          ? { artifactVersionId: args.artifactVersionId ?? action.artifactVersionId, packageSha256: args.packageSha256 }
          : {}),
        ...(operation === "rollback" ? { deploymentId: args.deploymentId } : {}),
      },
    };
  }
  const serverActions = records(status.data.pendingActions),
    serverIntent =
      serverActions.find((action) => action.id === localIntent?.input.actionId) ??
      serverActions.find((action) => !["succeeded", "failed", "denied", "expired"].includes(str(action, "status")));
  const intent = serverIntent ? fromAction(serverIntent) : localIntent;
  const scope = (order.data.scope ?? {}) as Row,
    matching = records(profiles.data.items).filter((profile) => {
      const s = profile.scope as Row;
      return ["companyId", "areaId", "customerId", "projectId"].every((key) => s?.[key] === scope[key]);
    }),
    profile = matching.find((p) => p.id === selected),
    deployments = records(status.data.deployments).filter((d) => d.profileId === selected),
    resource = records(status.data.resources).find((r) => r.profileId === selected);
  const current = records(artifacts.data.items).find((a) => a.id === workflow.artifactVersionId);
  const eligible = records(mandates.data.items).filter((m) => {
    const s = m.scope as Row;
    return (
      !m.revokedAt &&
      Date.parse(str(m, "expiresAt")) > Date.now() &&
      ["companyId", "areaId", "customerId", "projectId"].every((key) => s?.[key] === scope[key]) &&
      Array.isArray(m.targetIds) &&
      m.targetIds.includes(selected)
    );
  });
  function hold(value: Intent | null) {
    setIntent(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      /* State remains available in this session. */
    }
  }
  async function save(path: string, body: Row) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request(path, { method: "POST", body });
      profiles.reload();
      mandates.reload();
      status.reload();
      onChange();
      setMessage(
        t(
          "Gespeichert. Externe Ausführung benötigt eine eigene Freigabe.",
          "Saved. External execution requires a separate approval.",
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
      const latest = await request(`${base}/hosting`),
        stored = records(latest.pendingActions).find((action) => action.id === value.input.actionId);
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
    const result = await save(`${base}/hosting/${value.operation}`, value.input);
    if (result) hold({ ...value, state: str(result, "state", "unconfirmed") });
    else hold({ ...value, state: "unconfirmed" });
  }
  return (
    <details className={styles.panel}>
      <summary>{t("Hosting und Veröffentlichung", "Hosting and publication")}</summary>
      <p>
        {t(
          "Ein administrierter HTTPS-Broker nach ironcrew-hosting-v1 ist erforderlich. Profil und Mandat lösen noch keine Bestellung oder Veröffentlichung aus.",
          "An administered HTTPS broker implementing ironcrew-hosting-v1 is required. A profile and mandate do not place an order or publish anything.",
        )}
      </p>
      <Feedback error={error || profiles.error || status.error} message={message} />
      <Field label={t("Hostingprofil für diesen Auftrag", "Hosting profile for this order")}>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{t("Ziel auswählen", "Select target")}</option>
          {matching.map((p) => (
            <option key={str(p, "id")} value={str(p, "id")}>
              {str(p, "name")} · {str(p, "publicUrl")}
            </option>
          ))}
        </select>
      </Field>
      {profile && (
        <p>
          {str(profile, "stack")} · {str(profile, "plan")} · {t("Monatliche Kostenobergrenze", "Monthly cost limit")}:{" "}
          {money(profile.monthlyCostLimitUsdMicros, locale)}
          <span className={styles.json}>
            {t("Profil-ID", "Profile ID")}: {selected}
          </span>
        </p>
      )}
      <details>
        <summary>{t("Neues Hostingprofil anlegen", "Create hosting profile")}</summary>
        <form
          className={styles.settingsForm}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget),
              lines = (key: string) =>
                String(f.get(key))
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean);
            void save("/hosting/profiles", {
              name: f.get("name"),
              scope,
              provider: "ironcrew-hosting-v1",
              endpoint: f.get("endpoint"),
              publicUrl: f.get("publicUrl"),
              stack: f.get("stack"),
              plan: f.get("plan"),
              monthlyCostLimitUsdMicros: String(Math.round(Number(f.get("cost")) * 1e6)),
              expectedDnsAddresses: lines("dns"),
              healthContains: lines("health"),
              timeoutMs: 30000,
              ...(f.get("ca") ? { trustedCaPem: f.get("ca") } : {}),
              ...(!anonymous
                ? {
                    secretRef: {
                      provider: "proton-pass",
                      shareId: f.get("shareId"),
                      itemId: f.get("itemId"),
                      field: f.get("field"),
                    },
                  }
                : {}),
            }).then((result) => {
              if (result) setSelected(str(result, "id"));
            });
          }}
        >
          <Field label={t("Name des Hostingprofils", "Hosting profile name")}>
            <input name="name" maxLength={120} required />
          </Field>
          <Field label={t("HTTPS-Broker-Endpunkt", "HTTPS broker endpoint")}>
            <input name="endpoint" type="url" pattern="https://.*" required />
          </Field>
          <Field label={t("Öffentliche HTTPS-Adresse (Rootpfad)", "Public HTTPS address (root path)")}>
            <input name="publicUrl" type="url" pattern="https://.*" required />
          </Field>
          <Field label={t("Hosting-Stack", "Hosting stack")}>
            <select name="stack" defaultValue={str(workflow, "stack", "static")}>
              <option value="static">HTML/CSS/JS</option>
              <option value="react">React</option>
              <option value="wordpress">WordPress</option>
            </select>
          </Field>
          <Field label={t("Tarifkennung des Brokers", "Broker plan identifier")}>
            <input name="plan" pattern="[A-Za-z0-9._-]{1,80}" required />
          </Field>
          <Field label={t("Monatliche Hostingobergrenze in USD", "Monthly hosting limit in USD")}>
            <input name="cost" type="number" min={0} step=".01" defaultValue={0} required />
          </Field>
          <Field label={t("Erlaubte DNS-IP-Adressen (eine je Zeile)", "Allowed DNS IP addresses (one per line)")}>
            <textarea name="dns" required />
          </Field>
          <Field
            label={t(
              "Erwartete Texte für Gesundheitsprüfung (einer je Zeile)",
              "Expected health check texts (one per line)",
            )}
          >
            <textarea name="health" required />
          </Field>
          <Field label={t("Öffentliche vertrauenswürdige CA (PEM, optional)", "Trusted public CA (PEM, optional)")}>
            <textarea name="ca" />
          </Field>
          <label className={styles.check}>
            <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
            {t(
              "Broker ausdrücklich ohne Authorization-Header nutzen (separater Netzschutz erforderlich)",
              "Explicitly use broker without Authorization header (separate network protection required)",
            )}
          </label>
          {!anonymous && (
            <>
              <Field label="Hosting Proton Share-ID">
                <input name="shareId" required />
              </Field>
              <Field label="Hosting Proton Item-ID">
                <input name="itemId" required />
              </Field>
              <Field label={t("Hosting Proton Feld", "Hosting Proton field")}>
                <input name="field" defaultValue="password" required />
              </Field>
            </>
          )}
          <button disabled={busy || !scope.companyId}>{t("Hostingprofil speichern", "Save hosting profile")}</button>
        </form>
      </details>
      {profile && (
        <>
          <details>
            <summary>{t("Mandat für dieses Hostingziel erstellen", "Create mandate for this hosting target")}</summary>
            <form
              className={styles.settingsForm}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void save("/mandates", {
                  id: crypto.randomUUID(),
                  version: 1,
                  scope,
                  targetIds: [selected],
                  allowedToolIds: f.getAll("tool"),
                  parameterConstraints: {},
                  expiresAt: new Date(String(f.get("expiresAt"))).toISOString(),
                  maxAttempts: Number(f.get("attempts")),
                  maxDurationSeconds: Number(f.get("duration")),
                  maxCostUsdMicros: String(Math.round(Number(f.get("cost")) * 1e6)),
                });
              }}
            >
              <fieldset>
                <legend>{t("Erlaubte Hostingaktionen", "Allowed hosting actions")}</legend>
                {[
                  "hosting.provision",
                  "website.publish",
                  "hosting.rollback",
                  "website.care.check",
                  "website.care.backup",
                  "website.care.update",
                ].map((tool) => (
                  <label className={styles.check} key={tool}>
                    <input type="checkbox" name="tool" value={tool} />
                    {tool}
                  </label>
                ))}
              </fieldset>
              <Field label={t("Hostingmandat gültig bis", "Hosting mandate expires at")}>
                <input name="expiresAt" type="datetime-local" required />
              </Field>
              <Field label={t("Maximale Hostingaktionen", "Maximum hosting actions")}>
                <input name="attempts" type="number" min={1} defaultValue={3} required />
              </Field>
              <Field
                label={t("Maximale Laufzeit je Hostingaktion (Sekunden)", "Maximum hosting action duration (seconds)")}
              >
                <input name="duration" type="number" min={1} defaultValue={120} required />
              </Field>
              <Field label={t("Kostenrahmen des Hostingmandats in USD", "Hosting mandate cost limit in USD")}>
                <input
                  name="cost"
                  type="number"
                  min={0}
                  step=".01"
                  defaultValue={Number(profile.monthlyCostLimitUsdMicros) / 1e6}
                  required
                />
              </Field>
              <button disabled={busy}>{t("Hostingmandat erteilen", "Issue hosting mandate")}</button>
            </form>
          </details>
          <p>
            {resource
              ? t("Hostingressource ist belegt vorhanden.", "A hosting resource is recorded.")
              : t("Noch keine bestätigte Hostingressource.", "No confirmed hosting resource yet.")}
          </p>
          <form
            className={styles.settingsForm}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                operation = String(f.get("operation")),
                mandate = eligible.find((m) => m.id === f.get("mandateId"));
              if (!mandate) return;
              void execute({
                operation,
                state: "proposed",
                input: {
                  actionId: crypto.randomUUID(),
                  profileId: selected,
                  mandateId: mandate.id,
                  mandateVersion: mandate.version,
                  ...(operation === "publish"
                    ? { artifactVersionId: workflow.artifactVersionId, packageSha256: current?.packageSha256 }
                    : {}),
                  ...(operation === "rollback" ? { deploymentId: f.get("deploymentId") } : {}),
                },
              });
            }}
          >
            <Field label={t("Hostingaktion", "Hosting action")}>
              <select name="operation">
                <option value="provision" disabled={!!resource}>
                  {t("Ressource bereitstellen", "Provision resource")}
                </option>
                <option
                  value="publish"
                  disabled={
                    !resource || !["accepted", "published"].includes(str(workflow, "state")) || !current?.packageSha256
                  }
                >
                  {t("Abgenommene Version veröffentlichen", "Publish accepted version")}
                </option>
                <option value="rollback" disabled={!deployments.length}>
                  {t("Vorherige Version wiederherstellen", "Roll back deployment")}
                </option>
              </select>
            </Field>
            <Field label={t("Gültiges Hostingmandat", "Valid hosting mandate")}>
              <select name="mandateId" required>
                <option value="">{t("Mandat auswählen", "Select mandate")}</option>
                {eligible.map((m) => (
                  <option key={str(m, "id")} value={str(m, "id")}>
                    {str(m, "id")} · {(m.allowedToolIds as string[]).join(", ")}
                  </option>
                ))}
              </select>
            </Field>
            {deployments.length > 0 && (
              <Field label={t("Deployment für Rückweg", "Deployment to roll back")}>
                <select name="deploymentId">
                  {deployments.map((d) => (
                    <option key={str(d, "id")} value={str(d, "id")}>
                      {str(d, "artifactVersionId")} · {str(d, "state")}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <p className={styles.json}>
              {t("Aktuelle Artefaktversion", "Current artifact version")}: {str(workflow, "artifactVersionId", "—")}
              <br />
              SHA-256: {current ? str(current, "packageSha256", "—") : "—"}
            </p>
            <label className={styles.check}>
              <input type="checkbox" required />
              {t(
                "Ziel, Kosten und konkrete Version geprüft; separate Freigabe anfordern.",
                "Target, cost and exact version reviewed; request separate approval.",
              )}
            </label>
            <button disabled={busy || !!intent}>
              {t("Konkrete Hostingfreigabe anfordern", "Request exact hosting approval")}
            </button>
          </form>
        </>
      )}
      {intent && (
        <div className={styles.panel}>
          <p>
            {t("Gespeicherte Hostingaktion", "Saved hosting action")}: {intent.operation} · {intent.state}
            <span className={styles.json}>{str(intent.input, "actionId")}</span>
          </p>
          <a href="/decisions">
            {t("Gebundene Freigabe in Entscheidungen prüfen", "Review bound approval in Decisions")}
          </a>
          {["proposed", "approved", "approval", "unconfirmed"].includes(intent.state) && (
            <button disabled={busy} onClick={() => void execute(intent)}>
              {t("Dieselbe Aktion nach Entscheidung fortsetzen", "Resume the same action after decision")}
            </button>
          )}
          {intent.state === "effect_unknown" && (
            <p className={styles.warning}>
              {t(
                "Externe Wirkung ungeklärt. Kein neuer Versuch; Ziel und Nachweis zuerst administrativ abgleichen.",
                "External effect unknown. Do not retry; reconcile target and evidence first.",
              )}
            </p>
          )}
          {["succeeded", "failed", "denied", "expired"].includes(intent.state) && (
            <button className={styles.secondary} onClick={() => hold(null)}>
              {t("Abgeschlossenen Vorgang ausblenden", "Dismiss finished action")}
            </button>
          )}
        </div>
      )}
      {deployments.map((d) => {
        const health = (d.health ?? {}) as Row;
        return (
          <article className={styles.resource} key={str(d, "id")}>
            <h4>{t("Auslieferungsnachweis", "Deployment evidence")}</h4>
            <p>
              {str(d, "state")} · {str(d, "artifactVersionId")}
            </p>
            <p>
              {t("Geprüft am", "Verified at")}: {str(health, "observedAt", "—")} · IP:{" "}
              {str(health, "connectedAddress", "—")}
            </p>
            <span className={styles.json}>SHA-256: {str(d, "packageSha256")}</span>
            {d.state === "rollback_accepted" && (
              <p>
                {t(
                  "Rückweg angenommen; erneute Gesundheitsprüfung erforderlich.",
                  "Rollback accepted; a fresh health check is required.",
                )}
              </p>
            )}
          </article>
        );
      })}
    </details>
  );
}
