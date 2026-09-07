import { useEffect, useId, useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
import FinanceAutomation from "./FinanceAutomation.tsx";
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row): row is Row => !!row && typeof row === "object") : [];
const amount = (value: unknown): bigint | null =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
function currencyAmount(value: bigint | null, currency: string, locale: string) {
  if (value === null) return locale === "de" ? "ungeklärt" : "unavailable";
  try {
    const format = new Intl.NumberFormat(locale, { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2,
      scale = 10n ** BigInt(digits);
    return format
      .formatToParts(value / scale)
      .map((part) => (part.type === "fraction" ? String(value % scale).padStart(digits, "0") : part.value))
      .join("");
  } catch {
    return `${value} minor ${currency}`;
  }
}
export default function Finance({ locale, areas = [] }: { locale: "de" | "en"; areas?: Row[] }) {
  const [data, setData] = useState<Row>({}),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const field = useId(),
    t = (de: string, en: string) => (locale === "de" ? de : en);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("ironcrew:update", refresh);
    return () => window.removeEventListener("ironcrew:update", refresh);
  }, []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void request("/finance")
      .then((result) => {
        if (alive) {
          setData(result);
          setError("");
        }
      })
      .catch((error) => alive && setError(error.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [revision]);
  const snapshots = rows(data.items).sort((a, b) => str(b, "observedAt").localeCompare(str(a, "observedAt"))),
    snapshot = snapshots.find((row) => row.id === selected) ?? snapshots[0],
    invoices = rows(snapshot?.invoices),
    vouchers = rows(data.vouchers);
  const time = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(locale)
      : t("Datenstand ungeklärt", "Timestamp unavailable");
  const groups = [...new Set(invoices.map((invoice) => str(invoice, "currency")))].map((currency) => {
    const matching = invoices.filter((invoice) => invoice.currency === currency);
    let open = 0n,
      overdue = 0n,
      paid = 0n,
      receivable = 0n,
      payable = 0n,
      unknown = 0n,
      partial = 0,
      invalid = false;
    for (const invoice of matching) {
      const total = amount(invoice.totalMinor),
        payment = amount(invoice.paidMinor);
      if (total === null || payment === null || payment > total) {
        invalid = true;
        continue;
      }
      const rest = total - payment;
      open += rest;
      paid += payment;
      if (payment > 0n && rest > 0n) partial++;
      if (Date.parse(str(invoice, "dueAt")) < Date.parse(str(snapshot ?? {}, "observedAt"))) overdue += rest;
      if (invoice.direction === "receivable") receivable += rest;
      else if (invoice.direction === "payable") payable += rest;
      else unknown += rest;
    }
    return {
      currency,
      open,
      overdue,
      paid,
      receivable,
      payable,
      unknown,
      partial,
      invalid,
      missingDirection: matching.some((invoice) => !["receivable", "payable"].includes(str(invoice, "direction"))),
    };
  });
  const invoiceVoucher = (invoice: Row) =>
    vouchers.find((voucher) => {
      const item = voucher.invoice as Row | undefined;
      return (
        item?.id === invoice.id &&
        (!snapshot?.scope ||
          ["companyId", "areaId", "customerId", "projectId"].every(
            (key) => (voucher.scope as Row | undefined)?.[key] === (snapshot.scope as Row | undefined)?.[key],
          ))
      );
    });
  const voucherLink = (voucher: Row | undefined) =>
    voucher && str(voucher, "orderId") ? (
      <div className={styles.financeLinks}>
        <a href={`/orders/${encodeURIComponent(str(voucher, "orderId"))}?tab=overview`}>
          {t("Beleg im Auftrag öffnen", "Open document in order")}
        </a>
        <a href={`/api/v1/finance/vouchers/${encodeURIComponent(str(voucher, "id"))}/original`} download>
          {t("Originalbeleg herunterladen", "Download original document")}
        </a>
      </div>
    ) : (
      <span className={styles.muted}>{t("Kein Beleg verknüpft", "No linked document")}</span>
    );
  if (loading && !snapshot && !vouchers.length)
    return <div className={styles.skeleton} aria-label={t("Finanzdaten laden", "Loading finance data")} />;
  return (
    <section aria-label={t("Finanzübersicht", "Financial overview")}>
      <div className={styles.sectionHeading}>
        <h2>{t("Belege und Zahlungsstände", "Documents and payment records")}</h2>
        <button className={styles.secondary} onClick={() => setRevision((value) => value + 1)} disabled={loading}>
          {t("Aktualisieren", "Refresh")}
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error} · {t("Angezeigte Daten können veraltet sein.", "Displayed data may be stale.")}
        </p>
      )}
      <p>
        {t(
          "Ein ausgewählter Datenstand; historische Berichte werden nicht addiert. Beträge bleiben je Währung getrennt.",
          "One selected snapshot; historical reports are not added together. Amounts stay separate by currency.",
        )}
      </p>
      {snapshots.length > 0 ? (
        <>
          <label htmlFor={field}>{t("Finanzdatenstand", "Financial snapshot")}</label>
          <select id={field} value={str(snapshot!, "id")} onChange={(event) => setSelected(event.target.value)}>
            {snapshots.map((row) => (
              <option key={str(row, "id")} value={str(row, "id")}>
                {time(row.observedAt)} ·{" "}
                {str(
                  areas.find((area) => area.id === (row.scope as Row | undefined)?.areaId) ?? {},
                  "name",
                  t("Bereich", "Area"),
                )}
              </option>
            ))}
          </select>
          <p className={styles.muted}>
            {t("Berichtsstand", "Report timestamp")}: {time(snapshot?.observedAt)}
          </p>
          <div className={styles.orderGrid}>
            {groups.map((group) => (
              <article
                className={styles.panel}
                key={group.currency}
                aria-label={`${t("Kennzahlen", "Metrics")} ${group.currency}`}
              >
                <h3>{group.currency}</h3>
                <dl className={styles.details}>
                  {[
                    [t("Forderungen offen", "Open receivables"), group.receivable],
                    [t("Verbindlichkeiten offen", "Open payables"), group.payable],
                    [t("Offen insgesamt", "Total outstanding"), group.open],
                    [t("Überfällig zum Datenstand", "Overdue at snapshot"), group.overdue],
                    [t("Erfasste Zahlungen", "Recorded payments"), group.paid],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt>{String(label)}</dt>
                      <dd>{currencyAmount(group.invalid ? null : (value as bigint), group.currency, locale)}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>{t("Teilbezahlte Belege", "Partially paid documents")}</dt>
                    <dd>{group.partial}</dd>
                  </div>
                </dl>
                {group.missingDirection && (
                  <p className={styles.warning}>
                    {t("Forderung oder Verbindlichkeit noch ungeklärt", "Receivable or payable not classified")}:{" "}
                    {currencyAmount(group.unknown, group.currency, locale)}.{" "}
                    {t(
                      "Die getrennten Summen enthalten nur zugeordnete Belege.",
                      "Separate totals include only classified documents.",
                    )}
                  </p>
                )}
                {group.invalid && (
                  <p role="alert">
                    {t("Unvollständige Betragsdaten; Summen ungeklärt.", "Incomplete amounts; totals unavailable.")}
                  </p>
                )}
              </article>
            ))}
          </div>
          {!invoices.length && (
            <p>{t("Dieser Datenstand enthält keine Belege.", "This snapshot contains no invoices.")}</p>
          )}
          <h3>{t("Belege und Quellen", "Documents and sources")}</h3>
          <div className={styles.resourceList}>
            {invoices.map((invoice) => {
              const total = amount(invoice.totalMinor),
                paid = amount(invoice.paidMinor);
              return (
                <article className={styles.resource} key={str(invoice, "id")}>
                  <h4>{str(invoice, "reference", str(invoice, "id"))}</h4>
                  <p>
                    {invoice.direction === "receivable"
                      ? t("Forderung", "Receivable")
                      : invoice.direction === "payable"
                        ? t("Verbindlichkeit", "Payable")
                        : t("Richtung ungeklärt", "Direction unclassified")}
                  </p>
                  <dl className={styles.details}>
                    <div>
                      <dt>{t("Gesamt", "Total")}</dt>
                      <dd>{currencyAmount(total, str(invoice, "currency"), locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("Erfasst bezahlt", "Recorded paid")}</dt>
                      <dd>{currencyAmount(paid, str(invoice, "currency"), locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("Restbetrag", "Outstanding")}</dt>
                      <dd>
                        {currencyAmount(
                          total !== null && paid !== null && total >= paid ? total - paid : null,
                          str(invoice, "currency"),
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Fällig", "Due")}</dt>
                      <dd>{time(invoice.dueAt)}</dd>
                    </div>
                    <div>
                      <dt>{t("Quelle", "Source")}</dt>
                      <dd>{str(invoice, "source", t("ungeklärt", "unavailable"))}</dd>
                    </div>
                    <div>
                      <dt>{t("Quellenstand", "Source timestamp")}</dt>
                      <dd>{time(invoice.observedAt)}</dd>
                    </div>
                  </dl>
                  {invoice.disputed === true && <p className={styles.warning}>{t("Bestritten", "Disputed")}</p>}
                  {invoice.paymentPause === true && (
                    <p className={styles.warning}>{t("Zahlung pausiert", "Payment paused")}</p>
                  )}
                  {voucherLink(invoiceVoucher(invoice))}
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <p className={styles.warning}>
          {t(
            "Noch kein geprüfter Finanzdatenstand verfügbar. Erfasste Belege sind unten erreichbar; fehlende Summen werden nicht als null ausgegeben.",
            "No verified financial snapshot available. Recorded documents are linked below; missing totals are not shown as zero.",
          )}
        </p>
      )}
      {!snapshot && vouchers.length > 0 && (
        <div className={styles.resourceList}>
          {vouchers.map((voucher) => (
            <article className={styles.resource} key={str(voucher, "id")}>
              <h3>{str((voucher.invoice as Row) ?? {}, "reference", str(voucher, "id"))}</h3>
              {voucherLink(voucher)}
            </article>
          ))}
        </div>
      )}
      <aside className={styles.warning}>
        <h3>{t("Bankstand nicht verfügbar", "Bank balance unavailable")}</h3>
        <p>
          {t(
            "Es liegt kein eigener bestätigter Bankstand vor. Belegsummen und erfasste Zahlungen sind kein Kontostand.",
            "No separately confirmed bank balance is available. Invoice totals and recorded payments are not an account balance.",
          )}
        </p>
        <p>
          {t(
            "Zahlungsvorbereitung und Bankimport sind kein Zahlungsnachweis.",
            "Payment preparation and bank import are not proof of payment.",
          )}
        </p>
      </aside>
      <FinanceAutomation locale={locale} vouchers={vouchers} />
    </section>
  );
}
