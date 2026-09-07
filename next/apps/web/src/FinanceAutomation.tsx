import { useEffect, useState, type FormEvent } from "react";
import { list, request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
import automationStyles from "./FinanceAutomation.module.css";
type Locale = "de" | "en";
const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row => !!row && typeof row === "object" && !Array.isArray(row))
    : [];
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const sameScope = (a: unknown, b: unknown) =>
  ["companyId", "areaId", "customerId", "projectId"].every((key) => object(a)[key] === object(b)[key]);
const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
// Nested labels give each native control a stable accessible name, including repeatable rule forms.
function Input({
  label,
  name,
  value,
  type = "text",
  min,
  max,
  required = true,
  pattern,
  step,
  maxLength,
}: {
  label: string;
  name: string;
  value?: string | number;
  type?: string;
  min?: number;
  max?: number;
  required?: boolean;
  pattern?: string;
  step?: string;
  maxLength?: number;
}) {
  return (
    <label className={styles.field}>
      {label}
      <input
        name={name}
        aria-label={label}
        type={type}
        defaultValue={value}
        min={min}
        max={max}
        required={required}
        pattern={pattern}
        step={step}
        maxLength={maxLength}
      />
    </label>
  );
}
function TargetFields({
  scope,
  connections,
  mandates,
  locale,
  mode,
}: {
  scope: Row;
  connections: Row[];
  mandates: Row[];
  locale: Locale;
  mode: "processing" | "reminder" | "hold";
}) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const [target, setTarget] = useState("");
  const tools =
    mode === "processing"
      ? ["sevdesk.voucher.upload", "sevdesk.voucher.stage"]
      : mode === "reminder"
        ? ["sevdesk.invoice.read", "sevdesk.reminder.send"]
        : [];
  const targets = connections.filter(
    (c) =>
      c.provider === "sevdesk" &&
      sameScope(c.scope, scope) &&
      tools.every((tool) => Array.isArray(c.enabledTools) && c.enabledTools.includes(tool)),
  );
  const permitted = mandates.filter(
    (m) =>
      sameScope(m.scope, scope) &&
      Array.isArray(m.targetIds) &&
      m.targetIds.includes(target) &&
      Date.parse(str(m, "expiresAt")) > Date.now() &&
      tools
        .filter((tool) => tool !== "sevdesk.invoice.read")
        .every((tool) => Array.isArray(m.allowedToolIds) && m.allowedToolIds.includes(tool)),
  );
  return (
    <>
      <label className={styles.field}>
        {t("sevdesk-Ziel im Bereich", "sevdesk target in scope")}
        <select
          aria-label={t("sevdesk-Ziel im Bereich", "sevdesk target in scope")}
          name="targetId"
          required
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">{t("Ziel auswählen", "Select target")}</option>
          {targets.map((c) => (
            <option key={str(c, "id")} value={str(c, "id")}>
              {str(c, "label", str(c, "id"))}
            </option>
          ))}
        </select>
      </label>
      {!targets.length && (
        <p className={styles.warning}>
          {t(
            "Kein passendes sevdesk-Ziel mit den benötigten Werkzeugen eingerichtet.",
            "No matching sevdesk target has the required tools configured.",
          )}{" "}
          <a href="/settings?tab=integrations">{t("Verbindungen einrichten", "Configure connections")}</a>
        </p>
      )}
      {mode !== "hold" && (
        <label className={styles.field}>
          {t("Gültiges Mandat", "Valid mandate")}
          <select
            aria-label={t("Gültiges Mandat", "Valid mandate")}
            key={target}
            name="mandateId"
            required
            defaultValue=""
          >
            <option value="">{t("Mandat auswählen", "Select mandate")}</option>
            {permitted.map((m) => (
              <option key={`${str(m, "id")}:${String(m.version)}`} value={`${str(m, "id")}:${String(m.version)}`}>
                {str(m, "label", str(m, "id"))} · v{String(m.version)}
              </option>
            ))}
          </select>
        </label>
      )}
      {target && mode !== "hold" && !permitted.length && (
        <p className={styles.warning}>
          {t(
            "Kein gültiges Mandat für dieses Ziel und diese Werkzeuge. Unter Einstellungen ein passendes Mandat anlegen.",
            "No valid mandate for this target and these tools. Create a matching mandate in Settings.",
          )}
        </p>
      )}
    </>
  );
}
export default function FinanceAutomation({ locale, vouchers }: { locale: Locale; vouchers: Row[] }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const [data, setData] = useState<Row>({}),
    [connections, setConnections] = useState<Row[]>([]),
    [mandates, setMandates] = useState<Row[]>([]),
    [orders, setOrders] = useState<Row[]>([]),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [voucherId, setVoucherId] = useState(""),
    [orderId, setOrderId] = useState(""),
    [holdOrderId, setHoldOrderId] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([request("/finance/automation"), request("/configuration"), list("/mandates"), list("/orders")])
      .then(([next, config, mandates, orders]) => {
        if (!alive) return;
        setData(next);
        setConnections(rows(config.connections));
        setMandates(mandates);
        setOrders(orders.filter((order) => order.kind === "finance"));
        setError("");
      })
      .catch((error) => {
        if (alive) setError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  useEffect(() => {
    const refresh = () => setRevision((r) => r + 1);
    window.addEventListener("ironcrew:update", refresh);
    return () => window.removeEventListener("ironcrew:update", refresh);
  }, []);
  const save = async (path: string, body: unknown) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`/finance/${path}`, { method: "POST", body });
      setNotice(t("Gespeichert. Der bestätigte Status wird neu geladen.", "Saved. Reloading the confirmed status."));
      setRevision((r) => r + 1);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const credentials = (form: FormData) => {
    const mandate = mandates.find((m) => `${str(m, "id")}:${String(m.version)}` === text(form, "mandateId"));
    if (!mandate) throw new Error(t("Gültiges Mandat auswählen.", "Select a valid mandate."));
    return { targetId: text(form, "targetId"), mandateId: mandate.id, mandateVersion: mandate.version };
  };
  const submit = (event: FormEvent<HTMLFormElement>, run: (form: FormData) => Promise<void>) => {
    event.preventDefault();
    try {
      void run(new FormData(event.currentTarget));
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const voucher = vouchers.find((v) => v.id === voucherId),
    invoice = object(voucher?.invoice),
    order = orders.find((o) => o.id === orderId),
    holdOrder = orders.find((o) => o.id === holdOrderId);
  const suitableVouchers = vouchers.filter(
    (v) =>
      str(object(v.invoice), "supplierId") &&
      str(object(v.invoice), "currency") &&
      str(v, "originalSha256") &&
      ["application/pdf", "image/png", "image/jpeg"].includes(str(v, "originalMediaType")),
  );
  const state = (value: unknown) =>
    ({
      proposed: t("Vorgeschlagen", "Proposed"),
      reviewed: t("Vom Finanzlead geprüft", "Reviewed by finance lead"),
      active: t("Vom CEO aktiviert", "Activated by CEO"),
      disabled: t("Deaktiviert", "Disabled"),
    })[String(value)] ?? String(value ?? "");
  const reasonText = (value: unknown) =>
    ({
      no_matching_processing_rule: t(
        "Keine aktive Belegregel passt zum Original.",
        "No active processing rule matches the original.",
      ),
      ambiguous_processing_rules: t(
        "Mehrere Belegregeln passen; eine fachliche Klärung ist erforderlich.",
        "Multiple rules match; finance review is required.",
      ),
      voucher_exception: t(
        "Beleg enthält eine Ausnahme, etwa Zahlungspause, Widerspruch oder fehlendes Belegdatum.",
        "The document has an exception such as a payment pause, dispute or missing date.",
      ),
      reminder_suppressed: t(
        "Erinnerung durch Widerspruch oder Zahlungspause gesperrt.",
        "Reminder blocked by dispute or payment pause.",
      ),
      payment_data_changed: t(
        "Zahlungsdaten haben sich geändert. Ein erneuter Abgleich ist nötig.",
        "Payment data changed. Reconciliation is required.",
      ),
      integration_not_configured: t("Live-Verbindung ist noch nicht aktiviert.", "Live connection is not enabled."),
      finance_target_unavailable: t(
        "Das sevdesk-Ziel ist in diesem Bereich nicht verfügbar.",
        "The sevdesk target is unavailable in this scope.",
      ),
      needs_review: t("Fachliche Prüfung erforderlich", "Finance review required"),
      blocked: t("Blockiert", "Blocked"),
      staged: t("Als Entwurf bereitgestellt", "Staged as draft"),
      succeeded: t("Ausführung bestätigt", "Execution confirmed"),
      effect_unknown: t("Externe Wirkung ungeklärt", "External effect unknown"),
    })[String(value)] ?? String(value ?? "");
  const document = (row: Row): Row => ({ ...object(row.data), id: row.id, scope: row.scope });
  const processing = rows(data.processingRules).map(document),
    reminders = rows(data.reminderPolicies).map(document);
  return (
    <section className={automationStyles.content} aria-label={t("Finanzautomatisierung", "Finance automation")}>
      <div className={styles.sectionHeading}>
        <h2>{t("Belegregeln und Erinnerungen", "Document rules and reminders")}</h2>
        <button className={styles.secondary} disabled={loading || busy} onClick={() => setRevision((r) => r + 1)}>
          {t("Regelstatus aktualisieren", "Refresh rule status")}
        </button>
      </div>
      <p>
        {t(
          "Belegregeln werden zunächst vorgeschlagen, vom Finanzlead mit Nachweis geprüft und erst danach von dir aktiviert. Erinnerungen zeigen vor ihrer Aktivierung den genauen Empfänger und Nachrichtentext.",
          "Document rules are proposed, reviewed with evidence by the finance lead, then activated by you. Reminders show the exact recipient and message before activation.",
        )}
      </p>
      {loading && <p role="status">{t("Regeln werden geladen…", "Loading rules…")}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <details className={styles.panel}>
        <summary>{t("Belegregel aus Original vorschlagen", "Propose rule from original document")}</summary>
        <label className={styles.field}>
          {t("Originalbeleg für die Regel", "Original document for rule")}
          <select
            aria-label={t("Originalbeleg für die Regel", "Original document for rule")}
            value={voucherId}
            onChange={(e) => setVoucherId(e.target.value)}
          >
            <option value="">{t("Beleg auswählen", "Select document")}</option>
            {suitableVouchers.map((v) => (
              <option key={str(v, "id")} value={str(v, "id")}>
                {str(object(v.invoice), "reference", str(v, "id"))}
              </option>
            ))}
          </select>
        </label>
        {!suitableVouchers.length && (
          <p>
            {t(
              "Zuerst einen Originalbeleg mit Lieferant und Währung in einem Finanzauftrag erfassen.",
              "First record an original document with supplier and currency in a finance order.",
            )}
          </p>
        )}
        {voucher && (
          <form
            key={voucherId}
            onSubmit={(event) =>
              submit(event, (form) =>
                save("processing-rules", {
                  scope: voucher.scope,
                  sourceVoucherId: voucher.id,
                  supplierId: invoice.supplierId,
                  currency: invoice.currency,
                  minTotalMinor: text(form, "minTotalMinor"),
                  maxTotalMinor: text(form, "maxTotalMinor"),
                  mediaTypes: [voucher.originalMediaType],
                  ...credentials(form),
                  sevdeskSupplierId: Number(text(form, "sevdeskSupplierId")),
                  accountDatevId: Number(text(form, "accountDatevId")),
                  taxRuleId: text(form, "taxRuleId"),
                  taxRate: Number(text(form, "taxRate")),
                  source: text(form, "source"),
                }),
              )
            }
          >
            <p>
              {t("Lieferant", "Supplier")}: {str(invoice, "supplierId")} · {t("Währung", "Currency")}:{" "}
              {str(invoice, "currency")} · {str(voucher, "originalMediaType")}
            </p>
            <a href={`/api/v1/finance/vouchers/${encodeURIComponent(voucherId)}/original`} download>
              {t("Regelbeleg herunterladen", "Download rule source")}
            </a>
            <Input
              label={t("Mindestbetrag in kleinster Währungseinheit", "Minimum amount in minor currency units")}
              name="minTotalMinor"
              value={str(invoice, "totalMinor")}
              pattern="[0-9]{1,12}"
            />
            <Input
              label={t("Höchstbetrag in kleinster Währungseinheit", "Maximum amount in minor currency units")}
              name="maxTotalMinor"
              value={str(invoice, "totalMinor")}
              pattern="[0-9]{1,12}"
            />
            <TargetFields
              scope={object(voucher.scope)}
              connections={connections}
              mandates={mandates}
              locale={locale}
              mode="processing"
            />
            <Input
              label={t("sevdesk-Lieferanten-ID", "sevdesk supplier ID")}
              name="sevdeskSupplierId"
              type="number"
              min={1}
            />
            <Input label={t("DATEV-Konto-ID", "DATEV account ID")} name="accountDatevId" type="number" min={1} />
            <label className={styles.field}>
              {t("sevdesk-Steuerregel", "sevdesk tax rule")}
              <select
                aria-label={t("sevdesk-Steuerregel", "sevdesk tax rule")}
                name="taxRuleId"
                required
                defaultValue=""
              >
                <option value="">{t("Regel-ID auswählen", "Select rule ID")}</option>
                {["1", "2", "3", "4", "5", "11"].map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
            <Input
              label={t("Steuersatz in Prozent", "Tax rate percent")}
              name="taxRate"
              step="any"
              type="number"
              min={0}
              max={100}
            />
            <label className={styles.field}>
              {t("Begründung und Quelle der Zuordnung", "Reason and source for classification")}
              <textarea name="source" required maxLength={2000} rows={3} />
            </label>
            <button disabled={busy}>{t("Regel zur Prüfung vorschlagen", "Propose rule for review")}</button>
          </form>
        )}
      </details>
      <div className={styles.resourceList}>
        {processing.map((rule) => (
          <article
            className={styles.resource}
            key={str(rule, "id")}
            aria-label={`${t("Belegregel", "Document rule")} ${str(rule, "supplierId")}`}
          >
            <h3>
              {str(rule, "supplierId")} · {str(rule, "currency")}
            </h3>
            <p>
              {state(rule.state)} · {str(rule, "minTotalMinor")}–{str(rule, "maxTotalMinor")}{" "}
              {t("kleinste Einheiten", "minor units")}
            </p>
            <p>{str(rule, "source")}</p>
            <p>
              {t("Ziel", "Target")}: {str(rule, "targetId")} · DATEV {String(rule.accountDatevId)} ·{" "}
              {String(rule.taxRate)}%
            </p>
            <p>
              {t("Dateitypen", "File types")}:{" "}
              {Array.isArray(rule.mediaTypes) ? rule.mediaTypes.join(", ") : t("ungeklärt", "unavailable")} ·{" "}
              {t("Steuerregel", "Tax rule")}: {str(rule, "taxRuleId")} · {t("sevdesk-Lieferant", "sevdesk supplier")}:{" "}
              {String(rule.sevdeskSupplierId ?? "")}
            </p>
            <p>
              {t("Mandat", "Mandate")}: {str(rule, "mandateId")} · v{String(rule.mandateVersion ?? "")} ·{" "}
              {t("Bereich", "Area")}: {str(object(rule.scope), "areaId")}
            </p>
            {str(rule, "sourceVoucherId") && (
              <a
                href={`/api/v1/finance/vouchers/${encodeURIComponent(str(rule, "sourceVoucherId"))}/original`}
                download
              >
                {t("Original der Belegregel herunterladen", "Download rule source document")}
              </a>
            )}
            {rule.state === "proposed" && (
              <p>
                {t(
                  "Die Prüfung durch Saul steht aus. Beauftrage den Finanzlead im zugehörigen Finanzauftrag; eine CEO-Aktivierung ist erst mit gespeichertem Prüfnachweis möglich.",
                  "Saul's review is pending. Assign review to the finance lead in the related finance order; CEO activation requires a recorded review.",
                )}
              </p>
            )}
            {Boolean(rule.review) && (
              <p>
                {t("Prüfnachweis", "Review evidence")}: {str(object(rule.review), "evidence")}
              </p>
            )}
            {rule.state === "reviewed" && (
              <button disabled={busy} onClick={() => void save(`processing-rules/${str(rule, "id")}/activate`, {})}>
                {t("Geprüfte Regel als CEO aktivieren", "Activate reviewed rule as CEO")}
              </button>
            )}
            {["active", "reviewed", "proposed"].includes(str(rule, "state")) && (
              <button
                className={styles.secondary}
                disabled={busy}
                onClick={() => void save(`processing-rules/${str(rule, "id")}/disable`, {})}
              >
                {t("Belegregel deaktivieren", "Disable document rule")}
              </button>
            )}
          </article>
        ))}
      </div>
      <details className={styles.panel}>
        <summary>{t("Zahlungserinnerung vorbereiten", "Prepare payment reminder")}</summary>
        <label className={styles.field}>
          {t("Finanzauftrag für Erinnerung", "Finance order for reminder")}
          <select
            aria-label={t("Finanzauftrag für Erinnerung", "Finance order for reminder")}
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
          >
            <option value="">{t("Auftrag auswählen", "Select order")}</option>
            {orders.map((o) => (
              <option key={str(o, "id")} value={str(o, "id")}>
                {str(o, "goal")}
              </option>
            ))}
          </select>
        </label>
        {order && (
          <form
            key={orderId}
            onSubmit={(event) =>
              submit(event, (form) =>
                save("reminder-policies", {
                  scope: order.scope,
                  orderId: order.id,
                  ...credentials(form),
                  invoiceId: text(form, "invoiceId"),
                  recipient: text(form, "recipient"),
                  stage: Number(text(form, "stage")),
                  minOverdueDays: Number(text(form, "minOverdueDays")),
                  maxDataAgeSeconds: Number(text(form, "maxDataAgeSeconds")),
                  intervalSeconds: Number(text(form, "intervalSeconds")),
                  subject: text(form, "subject"),
                  text: text(form, "text"),
                }),
              )
            }
          >
            <TargetFields
              scope={object(order.scope)}
              connections={connections}
              mandates={mandates}
              locale={locale}
              mode="reminder"
            />
            <Input label={t("sevdesk-Rechnungs-ID", "sevdesk invoice ID")} name="invoiceId" pattern="[1-9][0-9]*" />
            <Input label={t("Genauer Empfänger", "Exact recipient")} name="recipient" type="email" />
            <Input
              label={t("Erinnerungsstufe", "Reminder stage")}
              name="stage"
              type="number"
              min={1}
              max={10}
              value={1}
            />
            <Input
              label={t("Mindestens Tage überfällig", "Minimum overdue days")}
              name="minOverdueDays"
              type="number"
              min={1}
              max={365}
              value={7}
            />
            <Input
              label={t("Zahlungsdaten höchstens alt (Sekunden)", "Maximum payment data age (seconds)")}
              name="maxDataAgeSeconds"
              type="number"
              min={1}
              max={300}
              value={60}
            />
            <Input
              label={t("Prüfintervall (Sekunden)", "Check interval (seconds)")}
              name="intervalSeconds"
              type="number"
              min={60}
              max={86400}
              value={3600}
            />
            <Input label={t("Genauer Betreff", "Exact subject")} name="subject" maxLength={200} />
            <label className={styles.field}>
              {t("Genauer Nachrichtentext", "Exact message text")}
              <textarea
                aria-label={t("Genauer Nachrichtentext", "Exact message text")}
                name="text"
                required
                maxLength={20000}
                rows={5}
              />
            </label>
            <p>
              {t(
                "Speichern bereitet die Regel vor. Erst die anschließende Aktivierung erlaubt den konkreten Versand; bezahlte, bestrittene und pausierte Rechnungen bleiben ausgeschlossen.",
                "Saving prepares the policy. Subsequent activation authorizes the exact message; paid, disputed and paused invoices remain excluded.",
              )}
            </p>
            <button disabled={busy}>{t("Erinnerung als Vorschlag speichern", "Save reminder proposal")}</button>
          </form>
        )}
      </details>
      <div className={styles.resourceList}>
        {reminders.map((policy) => (
          <article
            className={styles.resource}
            key={str(policy, "id")}
            aria-label={`${t("Erinnerung", "Reminder")} ${str(policy, "invoiceId")}`}
          >
            <h3>
              {t("Rechnung", "Invoice")} {str(policy, "invoiceId")} · {state(policy.state)}
            </h3>
            <p>
              {t("Empfänger", "Recipient")}: {str(policy, "recipient")} · {t("Stufe", "Stage")}: {String(policy.stage)}{" "}
              · {t("Prüfintervall", "Check interval")}: {String(policy.intervalSeconds)}s
            </p>
            <p>
              {t("Mindestens Tage überfällig", "Minimum overdue days")}: {String(policy.minOverdueDays)} ·{" "}
              {t("Zahlungsdaten höchstens alt", "Maximum payment data age")}: {String(policy.maxDataAgeSeconds)}s
            </p>
            <p>
              {t("Ziel", "Target")}: {str(policy, "targetId")} · {t("Mandat", "Mandate")}: {str(policy, "mandateId")} ·
              v{String(policy.mandateVersion)}
            </p>
            <h4>{str(policy, "subject")}</h4>
            <p className={automationStyles.message}>{str(policy, "text")}</p>
            {policy.state === "proposed" && (
              <button disabled={busy} onClick={() => void save(`reminder-policies/${str(policy, "id")}/activate`, {})}>
                {t("Diesen Empfänger und Text aktivieren", "Activate this recipient and message")}
              </button>
            )}
            {["proposed", "active"].includes(str(policy, "state")) && (
              <button
                className={styles.secondary}
                disabled={busy}
                onClick={() => void save(`reminder-policies/${str(policy, "id")}/disable`, {})}
              >
                {t("Erinnerung deaktivieren", "Disable reminder")}
              </button>
            )}
          </article>
        ))}
      </div>
      <details className={styles.panel}>
        <summary>{t("Zahlungspause oder Widerspruch erfassen", "Record payment pause or dispute")}</summary>
        <label className={styles.field}>
          {t("Finanzauftrag für Sperre", "Finance order for hold")}
          <select
            aria-label={t("Finanzauftrag für Sperre", "Finance order for hold")}
            value={holdOrderId}
            onChange={(e) => setHoldOrderId(e.target.value)}
          >
            <option value="">{t("Auftrag auswählen", "Select order")}</option>
            {orders.map((o) => (
              <option key={str(o, "id")} value={str(o, "id")}>
                {str(o, "goal")}
              </option>
            ))}
          </select>
        </label>
        {holdOrder && (
          <form
            key={holdOrderId}
            onSubmit={(event) =>
              submit(event, (form) =>
                save("invoice-holds", {
                  scope: holdOrder.scope,
                  targetId: text(form, "targetId"),
                  invoiceId: text(form, "invoiceId"),
                  disputed: form.has("disputed"),
                  paymentPause: form.has("paymentPause"),
                  source: text(form, "source"),
                }),
              )
            }
          >
            <TargetFields
              scope={object(holdOrder.scope)}
              connections={connections}
              mandates={mandates}
              locale={locale}
              mode="hold"
            />
            <Input label={t("Rechnungs-ID für Sperre", "Invoice ID for hold")} name="invoiceId" />
            <label>
              <input name="paymentPause" type="checkbox" /> {t("Zahlung pausiert", "Payment paused")}
            </label>
            <label>
              <input name="disputed" type="checkbox" /> {t("Rechnung bestritten", "Invoice disputed")}
            </label>
            <label className={styles.field}>
              {t("Grund und Quelle der Sperre oder Aufhebung", "Reason and source for hold or removal")}
              <textarea name="source" required maxLength={2000} rows={3} />
            </label>
            <p>
              {t(
                "Beide Häkchen entfernen hebt die gespeicherte Sperre auf. Die angegebene Quelle bleibt nachvollziehbar.",
                "Clearing both checkboxes removes the stored hold. The source remains recorded.",
              )}
            </p>
            <button disabled={busy}>{t("Sperrstatus speichern", "Save hold status")}</button>
          </form>
        )}
      </details>
      {rows(data.holds)
        .map(document)
        .map((hold) => (
          <p key={str(hold, "id")}>
            {t("Rechnung", "Invoice")} {str(hold, "invoiceId")}:{" "}
            {hold.disputed ? t("bestritten", "disputed") : t("nicht bestritten", "not disputed")} ·{" "}
            {hold.paymentPause ? t("Zahlung pausiert", "payment paused") : t("keine Zahlungspause", "no payment pause")}{" "}
            · {str(hold, "source")}
          </p>
        ))}
      <h3>{t("Letzte Automatisierungsschritte", "Recent automation steps")}</h3>
      {!rows(data.statuses).length && <p>{t("Noch keine Ausführung protokolliert.", "No execution recorded yet.")}</p>}
      <div className={styles.resourceList}>
        {rows(data.statuses)
          .map(document)
          .map((status) => (
            <article className={styles.resource} key={str(status, "id")}>
              <h4>{reasonText(str(status, "state", str(status, "status", str(status, "id"))))}</h4>
              <p>{reasonText(status.reason)}</p>
              <p>{str(status, "observedAt", str(status, "at"))}</p>
            </article>
          ))}
      </div>
      {rows(data.corrections).length > 0 && (
        <section aria-label={t("Wiederverwendbare Zuordnungskorrekturen", "Reusable classification corrections")}>
          <h3>{t("Wiederverwendbare Zuordnungskorrekturen", "Reusable classification corrections")}</h3>
          <p>
            {t(
              "Diese ausdrücklich vorgeschlagenen Korrekturen gelten nur für den gezeigten Bereich, Lieferanten, die Währung und den Belegtyp. Eine Einzelkorrektur am konkreten Beleg hat Vorrang. Die aktivierte Basisregel bestimmt weiterhin Ziel, Mandat und Betragsgrenzen.",
              "These explicitly proposed corrections apply only to the displayed scope, supplier, currency and document type. A one-off correction takes precedence for its own document. The active base rule still determines target, mandate and amount limits.",
            )}
          </p>
          {rows(data.corrections)
            .map(document)
            .map((correction) => (
              <article
                className={styles.resource}
                key={str(correction, "id")}
                aria-label={`${t("Zuordnungskorrektur", "Classification correction")} ${str(correction, "field")}`}
              >
                <h4>
                  {str(correction, "field")} → {String(correction.value)} · {t("Version", "Version")}{" "}
                  {Number(correction.version)} · {state(correction.state)}
                </h4>
                <p>
                  {str(correction, "scopeDescription")} · {str(object(correction.binding), "supplierId")} ·{" "}
                  {str(object(correction.binding), "currency")} · {str(object(correction.binding), "mediaType")}
                </p>
                <p>
                  {t("Bereich", "Area")}: {str(object(correction.scope), "areaId")} · {t("Begründung", "Reason")}:{" "}
                  {str(correction, "source")}
                </p>
                <a
                  href={`/api/v1/finance/vouchers/${encodeURIComponent(str(correction, "voucherId"))}/original`}
                  download
                >
                  {t("Original der Korrektur herunterladen", "Download correction source original")}
                </a>
                {correction.state === "proposed" && (
                  <p>
                    {t(
                      "Die echte Finanzlead-Prüfung auf Quelle und Widersprüche steht noch aus.",
                      "Actual finance lead review of source and conflicting rules is pending.",
                    )}
                  </p>
                )}
                {Boolean(correction.review) && (
                  <p>
                    {t("Prüfnachweis", "Review evidence")}: {str(object(correction.review), "evidence")}
                  </p>
                )}
                {correction.state === "reviewed" && (
                  <button
                    disabled={busy}
                    onClick={() => void save(`correction-rules/${str(correction, "id")}/activate`, {})}
                  >
                    {t("Geprüfte Zuordnungskorrektur aktivieren", "Activate reviewed classification correction")}
                  </button>
                )}
                {["active", "disabled"].includes(str(correction, "state")) && (
                  <details>
                    <summary>
                      {t("Zuordnung für künftige Belege ändern", "Change classification for future documents")}
                    </summary>
                    <p>
                      {t(
                        "Eine neue Version benötigt eine erneute Finanzlead-Prüfung und Aktivierung. Bereits übertragene Belege bleiben nachvollziehbar unverändert.",
                        "A new version requires another finance lead review and activation. Previously transferred documents retain their recorded classification.",
                      )}
                    </p>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        void save(`correction-rules/${str(correction, "id")}/revision`, {
                          value: correction.field === "taxRuleId" ? text(form, "value") : Number(text(form, "value")),
                          source: text(form, "source"),
                        });
                      }}
                    >
                      {correction.field === "taxRuleId" ? (
                        <label className={styles.field}>
                          {t("Neue Steuerregel", "New tax rule")}
                          <select
                            name="value"
                            aria-label={t("Neue Steuerregel", "New tax rule")}
                            defaultValue={String(correction.value)}
                          >
                            {["1", "2", "3", "4", "5", "11"].map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <Input
                          label={t("Neuer Zuordnungswert", "New classification value")}
                          name="value"
                          type="number"
                          value={Number(correction.value)}
                          min={correction.field === "taxRate" ? 0 : 1}
                          max={correction.field === "taxRate" ? 100 : undefined}
                          step={correction.field === "taxRate" ? "any" : "1"}
                        />
                      )}
                      <Input
                        label={t("Begründung der Änderung", "Reason for revision")}
                        name="source"
                        maxLength={2000}
                      />
                      <button disabled={busy}>{t("Neue Regelversion vorschlagen", "Propose new rule version")}</button>
                    </form>
                  </details>
                )}
                {["proposed", "reviewed", "active"].includes(str(correction, "state")) && (
                  <button
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void save(`correction-rules/${str(correction, "id")}/disable`, {})}
                  >
                    {t("Zuordnungskorrektur deaktivieren", "Disable classification correction")}
                  </button>
                )}
              </article>
            ))}
        </section>
      )}
    </section>
  );
}
