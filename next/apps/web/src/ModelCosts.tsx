import { useState, type FormEvent } from "react";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import { request, string as str, money, type Row } from "./api.ts";
import styles from "./App.module.css";
export default function ModelCosts({ locale }: { locale: Locale }) {
  const t = (de: string, en: string) => (locale === "de" ? de : en),
    costs = useRemote("/model-costs");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function discard(turn: Row) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request(`/orders/${str(turn, "orderId")}/model-response/discard`, {
        method: "POST",
        revision: turn.runRevision,
        body: { turnId: turn.id },
      });
      costs.reload();
      setMessage(
        t(
          "Fehlende Antwort ausdrücklich verworfen. Den Auftrag bei Bedarf erneut starten; dabei können neue Modellkosten entstehen.",
          "Missing response explicitly discarded. Start the order again if needed; this may incur new model costs.",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(turn: Row, mode: "provider" | "manual", event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const form = event ? new FormData(event.currentTarget) : undefined;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let body: Row = {};
      if (form) {
        const decimal = String(form.get("actual")).trim().replace(",", ".");
        if (!/^\d+(?:\.\d{1,6})?$/.test(decimal))
          throw Error(t("USD: maximal 6 Nachkommastellen.", "USD: up to 6 decimal places."));
        const [whole, fraction = ""] = decimal.split("."),
          file = form.get("evidence");
        if (!(file instanceof File) || !file.size || file.size > 500000)
          throw Error(t("Anbieterbeleg bis 500 kB auswählen.", "Choose provider evidence up to 500 kB."));
        let binary = "";
        for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte);
        body = {
          actualUsdMicros: (BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"))).toString(),
          evidence: {
            mediaType: form.get("mediaType"),
            description: form.get("description"),
            contentBase64: btoa(binary),
          },
        };
      }
      await request(`/model-costs/${str(turn, "id")}/${mode}`, { method: "POST", revision: turn.revision, body });
      costs.reload();
      setMessage(
        t(
          "Modellkosten abgeglichen. Ein verlorenes Modellergebnis bleibt ungeklärt.",
          "Model cost reconciled. A missing model response remains unresolved.",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel}>
      <h2>{t("Modellkosten abgleichen", "Reconcile model costs")}</h2>
      <p>
        {t(
          "Ungeklärte Beträge bleiben im Firmenbudget gebunden. Der Anbieterabgleich verwendet ausschließlich die bereits gespeicherte Generation und Modellzuordnung. Ein Kostenbeleg ersetzt keine verlorene Antwort und startet keine neue Modellanfrage.",
          "Unknown amounts remain reserved in the company budget. Provider reconciliation uses only the recorded generation and model binding. Cost evidence cannot replace a missing response or start another model call.",
        )}
      </p>
      <Feedback error={error || costs.error} message={message} />
      {costs.loading && <p>{t("Kosten werden geladen …", "Loading costs …")}</p>}
      {!costs.loading && !records(costs.data.turns).length && (
        <p>{t("Noch keine Modellaufrufe erfasst.", "No model turns recorded yet.")}</p>
      )}
      {records(costs.data.turns).map((turn) => (
        <article key={str(turn, "id")}>
          <h3>
            <a href={`/orders/${str(turn, "orderId")}`}>{str(turn, "modelId")}</a> ·{" "}
            {money(turn.actualUsdMicros ?? turn.reservedUsdMicros, locale)}
          </h3>
          <p>
            {turn.reservationState === "settled"
              ? t("Abgerechnet", "Settled")
              : t("Reserviert · Abrechnung ungeklärt", "Reserved · cost unresolved")}{" "}
            ·{" "}
            {turn.responseAvailable
              ? t("Modellantwort gespeichert", "Model response stored")
              : t("Modellantwort nicht gespeichert", "Model response not stored")}
          </p>
          {turn.discardAvailable === true && typeof turn.runRevision === "number" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void discard(turn);
              }}
            >
              <label className={styles.check}>
                <input type="checkbox" required />
                {t(
                  "Die fehlende Antwort verwerfen. Ein späterer Neustart kann erneut Modellkosten verursachen.",
                  "Discard the missing response. A later restart may incur new model costs.",
                )}
              </label>
              <button disabled={busy}>
                {t("Fehlende Modellantwort ausdrücklich verwerfen", "Explicitly discard missing model response")}
              </button>
            </form>
          )}
          {Boolean(turn.evidenceSha256) && <p className={styles.muted}>SHA-256: {str(turn, "evidenceSha256")}</p>}
          {["held", "unreconciled"].includes(str(turn, "reservationState")) && (
            <>
              {Boolean(turn.providerId) && (
                <button disabled={busy} onClick={() => void reconcile(turn, "provider")}>
                  {t("Gespeicherte Generation beim Anbieter abgleichen", "Reconcile recorded generation with provider")}
                </button>
              )}
              <details>
                <summary>
                  {t("Mit Anbieterbeleg manuell zuordnen", "Reconcile manually with provider evidence")}
                </summary>
                <form onSubmit={(e) => void reconcile(turn, "manual", e)}>
                  <Field label={t("Tatsächlich abgerechnete USD", "Actual billed USD")}>
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
                  <Field label={t("Originalbeleg", "Original evidence")}>
                    <input name="evidence" type="file" accept=".pdf,.json,.txt,.csv" required />
                  </Field>
                  <Field label={t("Zuordnung zu diesem Modellaufruf", "Attribution to this model turn")}>
                    <textarea name="description" maxLength={1000} required />
                  </Field>
                  <button disabled={busy}>{t("Belegte Kosten bestätigen", "Confirm evidenced cost")}</button>
                </form>
              </details>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
