import { useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function ReleaseUpdates({
  locale,
  policies,
  onChanged,
}: {
  locale: Locale;
  policies: Row[];
  onChanged: () => void;
}) {
  const remote = useRemote("/maintenance/releases"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  async function act(endpoint: string, body: Row) {
    setBusy(true);
    setError("");
    try {
      await request(`/maintenance/releases${endpoint}`, { method: "POST", body });
      remote.reload();
      onChanged();
      setMessage(
        t(
          "Updateangebot geprüft. Ein neuer Plan benötigt weiterhin deine Freigabe.",
          "Release checked. A new plan still requires your approval.",
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{t("Verfügbare Versionen", "Available versions")}</h3>
      <Feedback error={error || remote.error} message={message} />
      {remote.loading ? (
        <p role="status">{t("Versionsangebote laden…", "Loading release offers…")}</p>
      ) : remote.data.configured ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("/discover", { policyId: new FormData(e.currentTarget).get("policyId") });
            }}
          >
            <Field label={t("Updaterichtlinie", "Update policy")}>
              <select name="policyId" required>
                {policies
                  .filter((p) => !p.revoked)
                  .map((p) => (
                    <option value={str(p, "id")} key={str(p, "id")}>
                      {str(p, "name", str(p, "id"))}
                    </option>
                  ))}
              </select>
            </Field>
            <button disabled={busy || policies.length === 0}>
              {t("Signierte Versionsangebote prüfen", "Check signed release offers")}
            </button>
          </form>
          {records(remote.data.candidates).length === 0 && (
            <p>{t("Keine passende neuere Version gefunden.", "No matching newer release found.")}</p>
          )}
          <div className={styles.resourceList}>
            {records(remote.data.candidates).map((c) => {
              const r = c.release as Row;
              return (
                <article className={styles.resource} key={str(c, "id")}>
                  <h4>IronCrew {str(r, "version")}</h4>
                  <p>
                    {str(r, "platform")} / {str(r, "arch")} · {str(c, "updateClass")}
                  </p>
                  <p>
                    {t("Angebot gültig bis", "Offer valid until")}: {str(c, "feedExpiresAt")}
                  </p>
                  <p>
                    {c.classAllowed
                      ? t(
                          "Diese Updateklasse ist in der Richtlinie vorgesehen.",
                          "The policy allows this update class.",
                        )
                      : t(
                          "Diese Updateklasse ist von der Richtlinie ausgeschlossen.",
                          "The policy excludes this update class.",
                        )}
                  </p>
                  <button
                    disabled={busy || !c.classAllowed}
                    onClick={() => void act(`/candidates/${str(c, "id")}/stage-plan`, {})}
                  >
                    {t("Paket prüfen und Updateplan erstellen", "Verify package and create update plan")}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <p>
          {t(
            "Noch keine vertrauenswürdige Versionsquelle eingerichtet. Die Installation kann weiterhin ein konkret bereitgestelltes signiertes Paket prüfen.",
            "No trusted release feed configured yet. A supplied signed release can still be verified.",
          )}
        </p>
      )}
    </section>
  );
}
