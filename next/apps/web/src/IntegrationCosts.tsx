import { useState, type FormEvent } from "react";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import { request, string as str, money, type Row } from "./api.ts";
import styles from "./App.module.css";
function micros(value: FormDataEntryValue | null): string {
  const text = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) throw new Error("USD: maximal 6 Nachkommastellen / decimal places");
  const [whole, part = ""] = text.split(".");
  return (BigInt(whole!) * 1000000n + BigInt(part.padEnd(6, "0"))).toString();
}
export default function IntegrationCosts({ locale }: { locale: Locale }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const costs = useRemote("/integration-costs"),
    configuration = useRemote("/configuration");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const targets = records(configuration.data.connections).filter((c) => c.provider === "brave");
  const savePrice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const latest = await request("/configuration"),
        connections = records(latest.connections);
      const target = connections.find((c) => c.id === form.get("targetId"));
      if (!target || target.provider !== "brave")
        throw new Error(t("Suchverbindung fehlt", "Search connection missing"));
      const prior = (target.pricing ?? {}) as Row;
      if (JSON.stringify(target) !== JSON.stringify(targets.find((c) => c.id === target.id)))
        throw new Error(
          t("Verbindung wurde geändert. Ansicht aktualisieren.", "Connection changed. Refresh the view."),
        );
      const pricing = {
        id: prior.id ?? crypto.randomUUID(),
        version: Number(prior.version ?? 0) + 1,
        toolId: "research.search",
        currency: "USD",
        requestUsdMicros: micros(form.get("price")),
        validFrom: new Date().toISOString(),
        expiresAt: new Date(String(form.get("expiresAt"))).toISOString(),
        sourceUrl: form.get("sourceUrl"),
      };
      await request("/configuration", {
        method: "PUT",
        body: { ...latest, connections: connections.map((c) => (c.id === target.id ? { ...c, pricing } : c)) },
      });
      configuration.reload();
      setMessage(t("Neue Preisversion gespeichert.", "New price version saved."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async (event: FormEvent<HTMLFormElement>, charge: Row) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const file = form.get("evidence");
      if (!(file instanceof File) || !file.size || file.size > 500000)
        throw new Error(t("Beleg bis 500 kB auswählen.", "Choose evidence up to 500 kB."));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await request(`/integration-costs/${str(charge, "actionId")}/reconcile`, {
        method: "POST",
        revision: charge.revision,
        body: {
          actualUsdMicros: micros(form.get("actual")),
          evidence: {
            mediaType: form.get("mediaType"),
            contentBase64: btoa(binary),
            description: form.get("description"),
          },
        },
      });
      costs.reload();
      setMessage(t("Abrechnung mit Beleg gespeichert.", "Cost reconciled with evidence."));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel}>
      <h2>{t("Suchkosten", "Search costs")}</h2>
      <p>
        {t(
          "Suchanfragen reservieren ihren bestätigten Preis im Firmen-, Auftrags- und Mandatsbudget. Ungeklärte Abrechnungen bleiben gebunden, bis ein Beleg vorliegt.",
          "Search requests reserve their confirmed price against company, order and mandate budgets. Unknown charges remain reserved until supported by evidence.",
        )}
      </p>
      <Feedback error={error || costs.error || configuration.error} message={message} />
      <details>
        <summary>{t("Preis für Suchverbindung festlegen", "Set search connection price")}</summary>
        {!targets.length ? (
          <p>{t("Zuerst eine Brave-Verbindung einrichten.", "Configure a Brave connection first.")}</p>
        ) : (
          <form onSubmit={(e) => void savePrice(e)}>
            <Field label={t("Suchverbindung", "Search connection")}>
              <select name="targetId" required>
                {targets.map((target) => (
                  <option key={str(target, "id")} value={str(target, "id")}>
                    {str(target, "schemaTag")} · {str(target, "id")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Bestätigter Preis je Anfrage in USD", "Confirmed price per request in USD")}>
              <input name="price" inputMode="decimal" required />
            </Field>
            <Field label={t("Preisnachweis (HTTPS-Link)", "Price evidence (HTTPS link)")}>
              <input name="sourceUrl" type="url" pattern="https://.*" required />
            </Field>
            <Field label={t("Gültig bis", "Valid until")}>
              <input name="expiresAt" type="datetime-local" required />
            </Field>
            <button disabled={busy}>{t("Neue Preisversion speichern", "Save new price version")}</button>
          </form>
        )}
      </details>
      {!costs.loading && !records(costs.data.charges).length && (
        <p>{t("Noch keine Suchkosten angefallen.", "No search charges yet.")}</p>
      )}
      {records(costs.data.charges).map((charge) => (
        <article key={str(charge, "actionId")}>
          <h3>
            <a href={`/orders/${str(charge, "orderId")}`}>{t("Auftrag öffnen", "Open order")}</a> ·{" "}
            {money(charge.actualUsdMicros ?? ((charge.price ?? {}) as Row).requestUsdMicros, locale)}
          </h3>
          <p>
            {charge.status === "settled"
              ? t("Abgerechnet", "Settled")
              : charge.status === "cancelled"
                ? t("Ohne Kosten abgebrochen", "Cancelled without cost")
                : charge.status === "dispatched"
                  ? t("Angefragt – Abrechnung ausstehend", "Dispatched — awaiting cost")
                  : t("Abrechnung ungeklärt", "Cost unreconciled")}
          </p>
          {["unreconciled", "dispatched"].includes(str(charge, "status")) && (
            <details>
              <summary>{t("Mit Anbieterbeleg abgleichen", "Reconcile using provider evidence")}</summary>
              <form onSubmit={(e) => void reconcile(e, charge)}>
                <Field label={t("Tatsächliche Kosten in USD", "Actual cost in USD")}>
                  <input name="actual" inputMode="decimal" required />
                </Field>
                <Field label={t("Belegformat", "Evidence format")}>
                  <select name="mediaType">
                    <option>application/pdf</option>
                    <option>application/json</option>
                    <option>text/plain</option>
                    <option>text/csv</option>
                  </select>
                </Field>
                <Field label={t("Anbieterbeleg", "Provider evidence")}>
                  <input name="evidence" type="file" accept=".pdf,.json,.txt,.csv" required />
                </Field>
                <Field label={t("Zuordnung der Abrechnung", "Explanation of charge attribution")}>
                  <textarea name="description" maxLength={1000} required />
                </Field>
                <button disabled={busy}>{t("Kosten mit Beleg bestätigen", "Confirm evidenced cost")}</button>
              </form>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
