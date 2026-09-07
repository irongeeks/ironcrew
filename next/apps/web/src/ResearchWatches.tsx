import { useState } from "react";
import { request, string as str, money, type Row } from "./api.ts";
import { Field, Feedback, records, useRemote, type Locale } from "./Operations.tsx";
import styles from "./App.module.css";
export default function ResearchWatches({ order, locale }: { order: Row; locale: Locale }) {
  const base = `/orders/${str(order, "id")}/research`,
    watches = useRemote(`${base}/watches`),
    reports = useRemote(base),
    mandates = useRemote("/mandates"),
    configuration = useRemote("/configuration");
  const [predecessor, setPredecessor] = useState(""),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [targetIds, setTargetIds] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const reportList = records(reports.data.items),
    report = reportList.find((item) => item.id === predecessor) ?? reportList[0],
    sources = records(report?.sources).filter((source) => source.status === "available" && source.contentSha256),
    connections = records(configuration.data.connections).filter(
      (connection) =>
        connection.provider === "research" &&
        Array.isArray(connection.enabledTools) &&
        connection.enabledTools.includes("research.fetch"),
    );
  const permitted = records(mandates.data.items).filter(
    (mandate) =>
      Array.isArray(mandate.allowedToolIds) &&
      mandate.allowedToolIds.includes("research.fetch") &&
      (mandate.scope as Row | undefined)?.areaId === (order.scope as Row | undefined)?.areaId,
  );
  return (
    <section>
      <h3>{t("Recherche beobachten", "Monitor research")}</h3>
      <p>
        {t(
          "Quellenänderungen werden als Nachweise erfasst. Eine geänderte Seite ändert weder Empfehlung noch Firmenregel automatisch.",
          "Source changes are recorded as evidence. A changed page does not automatically change a recommendation or company rule.",
        )}
      </p>
      <Feedback error={watches.error || reports.error || error} message={message} />
      <div className={styles.resourceList}>
        {records(watches.data.items).map((watch) => (
          <Watch key={str(watch, "id")} watch={watch} base={base} locale={locale} reload={watches.reload} />
        ))}
      </div>
      <details className={styles.panel}>
        <summary>{t("Neue Quellenbeobachtung", "New source watch")}</summary>
        {!sources.length ? (
          <p>
            {t(
              "Zuerst einen Recherchebericht mit verfügbaren, belegten Quellen erstellen.",
              "First create a research report with available, recorded sources.",
            )}
          </p>
        ) : (
          <form
            className={styles.settingsForm}
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              const f = new FormData(event.currentTarget),
                mandate = permitted.find((item) => item.id === f.get("mandateId"));
              try {
                if (!mandate || !sourceIds.length)
                  throw new Error(
                    t("Mandat und mindestens eine Quelle auswählen.", "Select a mandate and at least one source."),
                  );
                await request(`${base}/watches`, {
                  method: "POST",
                  body: {
                    title: f.get("title"),
                    relevantChanges: f.get("relevantChanges"),
                    sources: sources
                      .filter((source) => sourceIds.includes(str(source, "id")))
                      .map((source) => ({
                        targetId: targetIds[str(source, "id")] || str(connections[0] ?? {}, "id"),
                        url: source.url,
                        title: source.title,
                      })),
                    cadenceSeconds: Number(f.get("minutes")) * 60,
                    budgetLimitUsdMicros: order.budgetLimitUsdMicros,
                    mandateId: mandate.id,
                    mandateVersion: mandate.version,
                    predecessorArtifactId: report?.id,
                    enabled: f.get("enabled") === "on",
                  },
                });
                watches.reload();
                setMessage(t("Quellenbeobachtung gespeichert.", "Source watch saved."));
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label={t("Bezeichnung der Beobachtung", "Watch title")}>
              <input name="title" required maxLength={300} />
            </Field>
            <Field label={t("Welche Änderungen sind relevant?", "Which changes matter?")}>
              <textarea name="relevantChanges" required maxLength={5000} rows={3} />
            </Field>
            <Field label={t("Ausgangsbericht", "Baseline report")}>
              <select
                value={str(report ?? {}, "id")}
                onChange={(event) => {
                  setPredecessor(event.target.value);
                  setSourceIds([]);
                  setTargetIds({});
                }}
              >
                {reportList.map((item) => (
                  <option key={str(item, "id")} value={str(item, "id")}>
                    {str(item, "title")} · {str(item, "createdAt")}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset>
              <legend>{t("Belegte Ausgangsquellen", "Recorded baseline sources")}</legend>
              {sources.map((source) => (
                <div key={str(source, "id")}>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={sourceIds.includes(str(source, "id"))}
                      onChange={(event) =>
                        setSourceIds((value) =>
                          event.target.checked ? [...value, str(source, "id")] : value.filter((id) => id !== source.id),
                        )
                      }
                    />
                    {str(source, "title")}
                  </label>
                  <p className={styles.muted}>{str(source, "url")}</p>
                  {sourceIds.includes(str(source, "id")) && (
                    <Field label={`${t("Abrufverbindung für", "Fetch connection for")} ${str(source, "title")}`}>
                      <select
                        required
                        value={targetIds[str(source, "id")] ?? str(connections[0] ?? {}, "id")}
                        onChange={(event) =>
                          setTargetIds((value) => ({ ...value, [str(source, "id")]: event.target.value }))
                        }
                      >
                        {connections.map((connection) => (
                          <option key={str(connection, "id")} value={str(connection, "id")}>
                            {str(connection, "provider")} · {str(connection, "id")}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              ))}
            </fieldset>
            <Field label={t("Intervall in Minuten", "Interval in minutes")}>
              <input name="minutes" type="number" min={1} max={525600} defaultValue={1440} required />
            </Field>
            <Field label={t("Mandat für Quellenabrufe", "Mandate for source checks")}>
              <select name="mandateId" required>
                {permitted.map((mandate) => (
                  <option key={str(mandate, "id")} value={str(mandate, "id")}>
                    {str(mandate, "id")} · v{String(mandate.version)}
                  </option>
                ))}
              </select>
            </Field>
            <p>
              {t("Kostenrahmen entspricht dem Auftrag", "Budget matches the order")}:{" "}
              {money(order.budgetLimitUsdMicros, locale)}
            </p>
            <label className={styles.check}>
              <input name="enabled" type="checkbox" />
              {t("Regelmäßige Beobachtung aktivieren", "Enable recurring watch")}
            </label>
            <button disabled={busy || !permitted.length || !connections.length || !sourceIds.length}>
              {t("Beobachtung speichern", "Save watch")}
            </button>
          </form>
        )}
      </details>
    </section>
  );
}
function Watch({ watch, base, locale, reload }: { watch: Row; base: string; locale: Locale; reload: () => void }) {
  const path = `${base}/watches/${str(watch, "id")}`,
    checks = useRemote(`${path}/checks`),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const status = (value: unknown) =>
    ({
      running: t("Prüfung läuft", "Check running"),
      unchanged: t("Keine Inhaltsänderung", "No content change"),
      changed: t("Änderung zu beurteilen", "Change needs review"),
      incomplete: t("Prüfung unvollständig", "Check incomplete"),
    })[String(value)] ?? t("Noch nicht geprüft", "Not checked yet");
  async function mutate(suffix: string, body: Row, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await request(path + suffix, { method, body, ...(method === "PATCH" ? { revision: watch.revision } : {}) });
      checks.reload();
      reload();
      setMessage(t("Arbeitsstand gespeichert.", "Work state saved."));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={styles.resource}>
      <h4>{str(watch, "title")}</h4>
      <p>
        {watch.enabled ? t("Aktiv", "Enabled") : t("Pausiert", "Paused")} · {status(watch.lastStatus)}
      </p>
      <p>{str(watch, "relevantChanges")}</p>
      <p>
        {t("Nächste Prüfung", "Next check")}:{" "}
        {str(watch, "nextCheckAt") ? new Date(str(watch, "nextCheckAt")).toLocaleString(locale) : "—"}
      </p>
      <div className={styles.actions}>
        <button
          className={styles.secondary}
          disabled={busy || !!watch.activeCheckId || !watch.enabled}
          onClick={() => void mutate("/check", { checkId: crypto.randomUUID() })}
        >
          {t("Quellen jetzt prüfen", "Check sources now")}
        </button>
        <button
          className={styles.secondary}
          disabled={busy || !!watch.activeCheckId}
          onClick={() => void mutate("", { enabled: !watch.enabled }, "PATCH")}
        >
          {watch.enabled ? t("Beobachtung pausieren", "Pause watch") : t("Beobachtung aktivieren", "Enable watch")}
        </button>
      </div>
      <Feedback error={checks.error || error} message={message} />
      {records(checks.data.items)
        .sort((a, b) => str(b, "startedAt").localeCompare(str(a, "startedAt")))
        .map((check) => {
          const review = records(checks.data.reviews).find((review) => review.checkId === check.id);
          return (
            <details key={str(check, "id")} className={styles.panel}>
              <summary>
                {status(check.status)} · {new Date(str(check, "startedAt")).toLocaleString(locale)}
              </summary>
              {records(check.failures).map((failure, index) => (
                <p key={index} className={styles.warning}>
                  {str(failure, "url")} · {str(failure, "code")}
                </p>
              ))}
              {records(check.diffs).map((diff, index) => (
                <article key={index}>
                  <h5>{str(diff, "url")}</h5>
                  <div className={styles.documentWorkspace}>
                    <div>
                      <strong>{t("Vorher", "Before")}</strong>
                      <p className={styles.documentText}>
                        {str(diff, "removedExcerpt") || t("Kein Textauszug", "No excerpt")}
                      </p>
                    </div>
                    <div>
                      <strong>{t("Nachher", "After")}</strong>
                      <p className={styles.documentText}>
                        {str(diff, "addedExcerpt") || t("Kein Textauszug", "No excerpt")}
                      </p>
                    </div>
                  </div>
                  {diff.truncated === true && (
                    <p className={styles.warning}>
                      {t(
                        "Auszug begrenzt; vollständige Bedeutung ist noch nicht bewertet.",
                        "Excerpt is limited; full meaning has not been evaluated.",
                      )}
                    </p>
                  )}
                </article>
              ))}
              {review ? (
                <p>
                  {t("Bewertet", "Reviewed")}: {str(review, "decision")} · {str(review, "reason")} ·{" "}
                  {str(review, "reviewerKind", t("Reviewer laut Nachweis", "Reviewer per record"))}
                </p>
              ) : check.status === "changed" && check.artifactVersionId ? (
                <Review
                  onSave={(body) => mutate(`/checks/${str(check, "id")}/review`, body)}
                  busy={busy}
                  locale={locale}
                />
              ) : null}
            </details>
          );
        })}
    </article>
  );
}
function Review({ onSave, busy, locale }: { onSave: (body: Row) => Promise<void>; busy: boolean; locale: Locale }) {
  const [decision, setDecision] = useState("maintain"),
    t = (de: string, en: string) => (locale === "de" ? de : en);
  return (
    <form
      className={styles.settingsForm}
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        void onSave({
          decision,
          reason: f.get("reason"),
          ...(decision === "revise" ? { recommendation: f.get("recommendation") } : {}),
        });
      }}
    >
      <h5>{t("Persönliche Bewertung als CEO", "Personal CEO assessment")}</h5>
      <Field label={t("Folge für die Empfehlung", "Effect on recommendation")}>
        <select value={decision} onChange={(event) => setDecision(event.target.value)}>
          <option value="maintain">{t("Bisherige Empfehlung beibehalten", "Keep current recommendation")}</option>
          <option value="revise">{t("Neue Empfehlung festhalten", "Record revised recommendation")}</option>
          <option value="irrelevant">{t("Änderung ist nicht relevant", "Change is not relevant")}</option>
        </select>
      </Field>
      <Field label={t("Begründung der Änderungsbewertung", "Reason for change assessment")}>
        <textarea name="reason" required maxLength={10000} />
      </Field>
      {decision === "revise" && (
        <Field label={t("Überarbeitete Empfehlung", "Revised recommendation")}>
          <textarea name="recommendation" required maxLength={10000} />
        </Field>
      )}
      <button disabled={busy}>
        {t("Persönliche Änderungsbewertung speichern", "Save personal change assessment")}
      </button>
    </form>
  );
}
