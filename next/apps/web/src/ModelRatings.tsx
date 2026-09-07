import { useEffect, useId, useState } from "react";
import { request, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
type Locale = "de" | "en";
function useRatings(path: string) {
  const [data, setData] = useState<Row>({}),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("ironcrew:update", refresh);
    return () => window.removeEventListener("ironcrew:update", refresh);
  }, []);
  useEffect(() => {
    let alive = true;
    void request(path)
      .then((value) => {
        if (alive) {
          setData(value);
          setError("");
        }
      })
      .catch((error) => alive && setError(error.message));
    return () => {
      alive = false;
    };
  }, [path, revision]);
  return { data, error, reload: () => setRevision((value) => value + 1) };
}
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
export function ModelRatingSummary({ locale }: { locale: Locale }) {
  const { data, error } = useRatings("/models/ratings"),
    t = (de: string, en: string) => (locale === "de" ? de : en);
  const mean = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString(locale, { maximumFractionDigits: 2 })
      : t("noch nicht bewertet", "not rated yet");
  return (
    <section className={styles.panel}>
      <h3>{t("Nachgewiesene Modellbewertungen", "Recorded model ratings")}</h3>
      <p>
        {t(
          "Qualität 1–5 aus expliziten Bewertungen. Menschliche und Agentenstichproben bleiben getrennt; Korrekturen zählen je Bewertung nur in ihrer neuesten Version.",
          "Quality 1–5 from explicit assessments. Human and agent samples remain separate; corrections count only their latest version.",
        )}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : rows(data.items).length ? (
        <div className={styles.resourceList}>
          {rows(data.items).map((item) => {
            const human = item.human as Row,
              agent = item.agent as Row,
              latency = item.latency as Row;
            return (
              <article className={styles.resource} key={str(item, "modelId")}>
                <h4>{str(item, "modelId")}</h4>
                <dl className={styles.details}>
                  <div>
                    <dt>{t("Menschliche Qualität", "Human quality")}</dt>
                    <dd>
                      {mean(human.qualityMean)} · n={String(human.samples)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("Agentenqualität", "Agent quality")}</dt>
                    <dd>
                      {mean(agent.qualityMean)} · n={String(agent.samples)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("Gemessene Modelllatenz", "Measured model latency")}</dt>
                    <dd>
                      {typeof latency.meanMs === "number"
                        ? `${mean(latency.meanMs)} ms`
                        : t("nicht gemessen", "not measured")}{" "}
                      · n={String(latency.samples)}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      ) : (
        <p>
          {t(
            "Noch keine bewertbaren Modellaufrufe. Bestandene Tests allein erzeugen keine Qualitätsnote.",
            "No rateable model calls yet. Passed tests alone do not generate a quality score.",
          )}
        </p>
      )}
    </section>
  );
}
export function OrderModelRating({ orderId, locale }: { orderId: string; locale: Locale }) {
  const path = `/orders/${encodeURIComponent(orderId)}/model-ratings`,
    { data, error, reload } = useRatings(path),
    id = useId();
  const [selected, setSelected] = useState(""),
    [quality, setQuality] = useState(""),
    [evidence, setEvidence] = useState(""),
    [message, setMessage] = useState(""),
    [saveError, setSaveError] = useState(""),
    [busy, setBusy] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const targets = rows(data.targets),
    target = targets.find((row) => row.artifactVersionId === selected) ?? targets[0];
  const prior = rows(data.items).find(
    (row) =>
      row.artifactVersionId === target?.artifactVersionId &&
      row.modelTurnId === target?.modelTurnId &&
      row.reviewerKind === "human",
  );
  return (
    <details className={styles.panel}>
      <summary>{t("Modellleistung bewerten", "Rate model performance")}</summary>
      <p>
        {t(
          "Deine persönliche Bewertung einer konkreten Artefaktversion. Modell und erzeugender Aufruf werden anhand gespeicherter Werkzeugergebnisse gebunden.",
          "Your personal rating of a specific artifact version. Its model and producing turn are bound to persisted tool results.",
        )}
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!target ? (
        <p>
          {t(
            "Keine eindeutig einem Modellaufruf zugeordnete Artefaktversion vorhanden. Manuelle Ergebnisse erhalten keine erfundene Modellnote.",
            "No artifact version uniquely linked to a model turn. Manual results do not receive a fabricated model rating.",
          )}
        </p>
      ) : (
        <form
          className={styles.settingsForm}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setSaveError("");
            setMessage("");
            try {
              const saved = await request(path, {
                method: "POST",
                body: {
                  artifactVersionId: target.artifactVersionId,
                  modelTurnId: target.modelTurnId,
                  quality: Number(quality),
                  evidence,
                  expectedVersion: Number(prior?.version ?? 0),
                },
              });
              setMessage(
                t(`Bewertungsversion ${saved.version} gespeichert.`, `Rating version ${saved.version} saved.`),
              );
              setQuality("");
              setEvidence("");
              reload();
              window.dispatchEvent(new Event("ironcrew:update"));
            } catch (error) {
              setSaveError(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor={`${id}-target`}>{t("Bewertete Artefaktversion", "Rated artifact version")}</label>
          <select
            id={`${id}-target`}
            value={str(target, "artifactVersionId")}
            onChange={(event) => {
              setSelected(event.target.value);
              setQuality("");
              setEvidence("");
            }}
          >
            {targets.map((row) => (
              <option key={str(row, "artifactVersionId")} value={str(row, "artifactVersionId")}>
                {str(row, "modelId")} · {str(row, "artifactVersionId")}
              </option>
            ))}
          </select>
          <p className={styles.muted}>SHA-256: {str(target, "artifactSha256")}</p>
          {prior && (
            <p>
              {t("Bisherige persönliche Bewertung", "Previous personal rating")}: {String(prior.quality)}/5 · v
              {String(prior.version)}
            </p>
          )}
          <label htmlFor={`${id}-quality`}>
            {t("Persönliche Qualitätsnote (1–5)", "Personal quality score (1–5)")}
          </label>
          <select id={`${id}-quality`} required value={quality} onChange={(event) => setQuality(event.target.value)}>
            <option value="">{t("Bewusst auswählen", "Choose explicitly")}</option>
            {[1, 2, 3, 4, 5].map((score) => (
              <option key={score} value={score}>
                {score} / 5
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-evidence`}>{t("Begründung der Modellbewertung", "Evidence for model rating")}</label>
          <textarea
            id={`${id}-evidence`}
            required
            rows={3}
            maxLength={10000}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
          <button disabled={busy}>{t("Persönliche Bewertung versionieren", "Save personal rating version")}</button>
        </form>
      )}
      {saveError && (
        <p role="alert" className={styles.error}>
          {saveError}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
