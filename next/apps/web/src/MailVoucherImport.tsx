import { useState } from "react";
import type { Row } from "./api.ts";
import { string as str } from "./api.ts";
import { Field, records, type Locale } from "./Operations.tsx";
export default function MailVoucherImport({
  message,
  locale,
  busy,
  onImport,
}: {
  message: Row;
  locale: Locale;
  busy: boolean;
  onImport: (body: Row) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const attachments = records(message.attachments).filter((a) =>
    ["application/pdf", "image/png", "image/jpeg"].includes(str(a, "contentType")),
  );
  if ((message.channel as Row | undefined)?.kind !== "finance" || !attachments.length) return null;
  return (
    <details>
      <summary>{t("Anhang als Finanzbeleg übernehmen", "Import attachment as financial voucher")}</summary>
      <p>
        {t(
          "Prüfe die Angaben am Original. Es werden keine Beträge oder Zuordnungen aus der E-Mail geraten.",
          "Check each field against the original. Amounts and assignments are never guessed from the email.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            const f = new FormData(e.currentTarget),
              value = (name: string) => String(f.get(name) ?? "");
            const minor = (name: string) => {
              const m = /^(\d{1,10})(?:[,.](\d{1,2}))?$/.exec(value(name));
              if (!m)
                throw Error(
                  t(
                    "Betrag mit höchstens zwei Nachkommastellen eingeben.",
                    "Enter an amount with at most two decimal places.",
                  ),
                );
              return String(BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0")));
            };
            const date = value("voucherDate").split("-");
            void onImport({
              attachmentSha256: value("attachment"),
              voucherDate: `${date[2]}.${date[1]}.${date[0]}`,
              invoice: {
                id: value("reference"),
                reference: value("reference"),
                supplierId: value("supplierId"),
                direction: "payable",
                currency: value("currency"),
                totalMinor: minor("total"),
                paidMinor: minor("paid"),
                dueAt: new Date(`${value("due")}T23:59:59Z`).toISOString(),
                observedAt: new Date().toISOString(),
                source: "manual-original-review",
                disputed: f.get("disputed") === "on",
                paymentPause: f.get("paused") === "on",
              },
            });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <Field label={t("Originalanhang", "Original attachment")}>
          <select name="attachment" required>
            {attachments.map((a) => (
              <option key={str(a, "sha256")} value={str(a, "sha256")}>
                {str(a, "filename")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Lieferantenkennung", "Supplier identifier")}>
          <input name="supplierId" required />
        </Field>
        <Field label={t("Belegnummer", "Invoice reference")}>
          <input name="reference" required />
        </Field>
        <Field label={t("Belegdatum", "Invoice date")}>
          <input name="voucherDate" type="date" required />
        </Field>
        <Field label={t("Fälligkeit", "Due date")}>
          <input name="due" type="date" required />
        </Field>
        <Field label={t("Bruttobetrag", "Gross amount")}>
          <input name="total" inputMode="decimal" required />
        </Field>
        <Field label={t("Bereits bezahlt – bestätigter Betrag", "Already paid — verified amount")}>
          <input name="paid" inputMode="decimal" required />
        </Field>
        <Field label={t("Währung", "Currency")}>
          <input name="currency" pattern="[A-Z]{3}" defaultValue="EUR" required />
        </Field>
        <Field label={t("Beleg bestritten", "Invoice disputed")}>
          <input name="disputed" type="checkbox" />
        </Field>
        <Field label={t("Zahlung pausiert", "Payment paused")}>
          <input name="paused" type="checkbox" />
        </Field>
        <button disabled={busy}>{t("Geprüften Originalbeleg übernehmen", "Import verified original voucher")}</button>
      </form>
    </details>
  );
}
