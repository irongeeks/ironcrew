import { useI18n } from "../i18n";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ObjectiveCase,
  ObjectiveRubric,
  ObjectiveSnapshot,
  ObjectiveMeasurement,
} from "../shared/objective-evaluations";
import { requestJson } from "./panel-api";
import "./ObjectiveEvaluationsPanel.css";
const emptyCase = (id: number): ObjectiveCase => ({ id: `case-${id}`, label: "", kind: "contains", expected: "" });
export function ObjectiveEvaluationsPanel({ refreshKey }: { refreshKey?: number }): React.JSX.Element {
  const { t, locale } = useI18n();
  const formId = useId();
  const [data, setData] = useState<ObjectiveSnapshot | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [cases, setCases] = useState<ObjectiveCase[]>([emptyCase(1)]);
  const [rubricId, setRubricId] = useState("");
  const [runId, setRunId] = useState("");
  const sequence = useRef(1);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const snapshot = await requestJson<ObjectiveSnapshot>("/api/crew/evaluations");
      if (token === generation.current) {
        setData(snapshot);
        setError("");
      }
    } catch (cause) {
      if (token === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t({ de: "Auswertungen konnten nicht geladen werden.", en: "Could not load evaluations." }),
        );
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [t]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate, refreshKey]);
  const mutate = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      setNotice(message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t({
              de: "Aktion fehlgeschlagen. Entwurf bleibt erhalten.",
              en: "Action failed. Your draft has been preserved.",
            }),
      );
    } finally {
      setBusy(false);
    }
  };
  const edit = (rubric?: ObjectiveRubric) => {
    setKey(rubric?.key ?? "");
    setTitle(rubric?.title ?? "");
    setReason("");
    setBaseVersion(rubric?.version ?? 0);
    setCases(rubric ? structuredClone(rubric.cases) : [emptyCase(++sequence.current)]);
  };
  const patchCase = (index: number, value: ObjectiveCase) =>
    setCases((current) => current.map((c, i) => (i === index ? value : c)));
  const replay = (measurement: ObjectiveMeasurement) =>
    mutate(
      async () => {
        const replayed = await requestJson<{ checks: ObjectiveMeasurement["checks"] }>(
          `/api/crew/evaluations/${encodeURIComponent(measurement.id)}/replay`,
        );
        if (JSON.stringify(replayed.checks) !== JSON.stringify(measurement.checks))
          throw new Error(
            t({
              de: "Wiederholung weicht vom gespeicherten Ergebnis ab.",
              en: "The repeated evaluation differs from the stored result.",
            }),
          );
      },
      t({
        de: "Gespeicherter Nachweis reproduziert: alle Einzelresultate stimmen überein.",
        en: "Stored evidence reproduced: all individual results match.",
      }),
    );
  return (
    <section className="objective-panel" aria-label={t({ de: "Objektive Tests", en: "Objective tests" })}>
      <header>
        <div>
          <p className="objective-eyebrow">{t({ de: "Qualität mit Nachweis", en: "Quality with evidence" })}</p>
          <h2>{t({ de: "Objektive Tests", en: "Objective tests" })}</h2>
        </div>
        <button type="button" disabled={loading || busy} onClick={() => void load()}>
          {t({ de: "Aktualisieren", en: "Refresh" })}{" "}
        </button>
      </header>
      <p>
        {t({
          de: "Prüfe gespeicherte Arbeitsergebnisse mit festen Kriterien. Die Erfüllungsquote ist getrennt von den 1–5 Sternen des Leads und ändert keine Mitarbeiterrolle.",
          en: "Check stored work results against fixed criteria. The pass rate is separate from the lead’s 1–5 stars and does not change employee roles.",
        })}{" "}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && !data && (
        <p role="status">
          {t({ de: "Rubriken und Run-Nachweise werden geladen …", en: "Loading rubrics and run evidence …" })}
        </p>
      )}
      {data && (
        <>
          <div className="objective-workspace">
            <section aria-label={t({ de: "Test ausführen", en: "Run test" })}>
              <h3>{t({ de: "Gespeicherten Run prüfen", en: "Check stored run" })}</h3>
              <p>
                {t({
                  de: "Es startet kein Modellaufruf. Jede Rubrikversion bewertet einen Run einmal; Wiederholung nutzt denselben Nachweis.",
                  en: "No model call is made. Each rubric version evaluates a run once; repeating it uses the same evidence.",
                })}{" "}
              </p>
              <label htmlFor={`${formId}-rubric`}>{t({ de: "Rubrikversion", en: "Rubric version" })}</label>
              <select id={`${formId}-rubric`} value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
                <option value="">{t({ de: "Rubrik auswählen", en: "Select rubric" })}</option>
                {data.rubrics.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} · v{r.version}
                  </option>
                ))}
              </select>
              <label htmlFor={`${formId}-run`}>{t({ de: "Abgeschlossener Run", en: "Completed run" })}</label>
              <select id={`${formId}-run`} value={runId} onChange={(e) => setRunId(e.target.value)}>
                <option value="">{t({ de: "Run auswählen", en: "Select run" })}</option>
                {data.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.agentName} · {r.taskTitle} · {r.runtimeType}/
                    {r.model ?? t({ de: "Standardmodell nicht erfasst", en: "Default model not recorded" })} · {r.id}
                  </option>
                ))}
              </select>
              {!data.runs.length && (
                <p>
                  {t({
                    de: "Noch kein abgeschlossener Run vorhanden. Führe zuerst eine Aufgabe mit einer eingerichteten Runtime aus.",
                    en: "No completed run yet. First execute a task with a configured runtime.",
                  })}{" "}
                </p>
              )}
              {!data.rubrics.length && (
                <p>
                  {t({
                    de: "Noch keine Rubrik vorhanden. Der Owner legt zuerst überprüfbare Abnahmekriterien an.",
                    en: "No rubric yet. The owner must first create verifiable acceptance criteria.",
                  })}
                </p>
              )}
              <button
                disabled={busy || !data.canMeasure || !rubricId || !runId}
                onClick={() =>
                  void mutate(
                    () =>
                      requestJson("/api/crew/evaluations/measure", {
                        method: "POST",
                        body: JSON.stringify({ rubricId, runId }),
                      }),
                    t({ de: "Auswertung gespeichert.", en: "Evaluation saved." }),
                  )
                }
              >
                {t({ de: "Run auswerten", en: "Evaluate run" })}{" "}
              </button>
              {!data.canMeasure && (
                <p>
                  {t({
                    de: "Auswertungen starten können Owner und Operatoren.",
                    en: "Owners and operators can start evaluations.",
                  })}
                </p>
              )}
            </section>
            {data.canEdit && (
              <form
                aria-label={t({ de: "Rubrik bearbeiten", en: "Edit rubric" })}
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(
                    async () => {
                      const result = await requestJson<{ rubric: ObjectiveRubric }>("/api/crew/evaluations/rubrics", {
                        method: "POST",
                        body: JSON.stringify({ key, baseVersion, title, reason, cases }),
                      });
                      setRubricId(result.rubric.id);
                      edit(result.rubric);
                    },
                    t({ de: "Unveränderliche Rubrikversion gespeichert.", en: "Immutable rubric version saved." }),
                  );
                }}
              >
                <h3>
                  {baseVersion
                    ? t({
                        de: `Rubrik überarbeiten · Basis v${baseVersion}`,
                        en: `Revise rubric · Based on v${baseVersion}`,
                      })
                    : t({ de: "Neue Rubrik", en: "New rubric" })}
                </h3>
                <label>
                  {t({ de: "Rubrikkennung", en: "Rubric identifier" })}{" "}
                  <input
                    required
                    pattern="[a-z][a-z0-9_-]{0,63}"
                    maxLength={64}
                    value={key}
                    disabled={baseVersion > 0}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={t({ de: "beispiel-qualitaet", en: "example-quality" })}
                  />
                </label>
                <label>
                  {t({ de: "Titel", en: "Title" })}{" "}
                  <input required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label>
                  {t({ de: "Änderungsgrund", en: "Reason for change" })}{" "}
                  <textarea
                    required
                    minLength={10}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                {cases.map((c, index) => (
                  <fieldset key={c.id}>
                    <legend>
                      {t({ de: "Prüfung", en: "Check" })} {index + 1}
                    </legend>
                    <label>
                      {t({ de: "Bezeichnung", en: "Label" })}{" "}
                      <input
                        required
                        maxLength={160}
                        value={c.label}
                        onChange={(e) => patchCase(index, { ...c, label: e.target.value })}
                      />
                    </label>
                    <label>
                      {t({ de: "Prüfart", en: "Check type" })}{" "}
                      <select
                        value={c.kind}
                        onChange={(e) =>
                          patchCase(
                            index,
                            e.target.value === "json_field"
                              ? { id: c.id, label: c.label, kind: "json_field", path: ["result"], valueType: "string" }
                              : {
                                  id: c.id,
                                  label: c.label,
                                  kind: e.target.value as "contains" | "excludes",
                                  expected: "",
                                },
                          )
                        }
                      >
                        <option value="contains">{t({ de: "Enthält Text", en: "Contains text" })}</option>
                        <option value="excludes">{t({ de: "Enthält keinen Text", en: "Excludes text" })}</option>
                        <option value="json_field">{t({ de: "JSON-Feld hat Typ", en: "JSON field has type" })}</option>
                      </select>
                    </label>
                    {c.kind === "json_field" ? (
                      <>
                        <label>
                          {t({ de: "Feldpfad (durch Punkt getrennt)", en: "Field path (dot separated)" })}{" "}
                          <input
                            required
                            value={c.path.join(".")}
                            onChange={(e) => patchCase(index, { ...c, path: e.target.value.split(".") })}
                          />
                        </label>
                        <label>
                          {t({ de: "Erwarteter Typ", en: "Expected type" })}{" "}
                          <select
                            value={c.valueType}
                            onChange={(e) =>
                              patchCase(index, { ...c, valueType: e.target.value as typeof c.valueType })
                            }
                          >
                            {["string", "number", "boolean", "array", "object", "null"].map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                        </label>
                      </>
                    ) : (
                      <label>
                        {t({ de: "Vergleichstext", en: "Comparison text" })}{" "}
                        <input
                          required
                          maxLength={2000}
                          value={c.expected}
                          onChange={(e) => patchCase(index, { ...c, expected: e.target.value })}
                        />
                      </label>
                    )}
                    {cases.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setCases((current) => current.filter((_, i) => i !== index))}
                      >
                        {t({ de: "Prüfung", en: "Check" })} {index + 1} {t({ de: "entfernen", en: "remove" })}{" "}
                      </button>
                    )}
                  </fieldset>
                ))}
                <div className="objective-actions">
                  <button
                    type="button"
                    disabled={cases.length >= 30 || busy}
                    onClick={() =>
                      setCases((current) => {
                        do {
                          sequence.current++;
                        } while (current.some((c) => c.id === `case-${sequence.current}`));
                        return [...current, emptyCase(sequence.current)];
                      })
                    }
                  >
                    {t({ de: "Prüfung hinzufügen", en: "Add check" })}{" "}
                  </button>
                  <button type="submit" disabled={busy}>
                    {t({ de: "Rubrikversion speichern", en: "Save rubric version" })}{" "}
                  </button>
                  <button type="button" disabled={busy} onClick={() => edit()}>
                    {t({ de: "Neue Rubrik beginnen", en: "Start new rubric" })}{" "}
                  </button>
                </div>
                <p>
                  {t({
                    de: "Textprüfungen beachten Groß-/Kleinschreibung. JSON-Prüfungen erwarten reines JSON. Kein Code und keine regulären Ausdrücke werden ausgeführt.",
                    en: "Text checks are case-sensitive. JSON checks require plain JSON. No code or regular expressions are executed.",
                  })}{" "}
                </p>
              </form>
            )}
          </div>
          <section aria-label="Modellvergleich">
            <h3>{t({ de: "Vergleich nach Rubrikversion", en: "Comparison by rubric version" })}</h3>
            <p>
              {t({
                de: "Gleiche Kriterien machen Ergebnisse nachvollziehbar. Unterschiedliche Aufgaben bleiben unterschiedlich schwer; diese Quote ist kein allgemeines Modellranking. Unbekannte Standardmodelle werden ausdrücklich ausgewiesen.",
                en: "Shared criteria make results traceable. Different tasks still have different difficulty; this rate is not a general model ranking. Unknown default models are identified explicitly.",
              })}{" "}
            </p>
            {!data.comparisons.length ? (
              <p>
                {t({
                  de: "Noch keine gemessenen Ergebnisse. Es werden keine Beispielwerte angezeigt.",
                  en: "No measured results yet. No sample values are shown.",
                })}
              </p>
            ) : (
              <div className="objective-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t({ de: "Rubrik", en: "Rubric" })}</th>
                      <th>{t({ de: "Mitarbeiter", en: "Employee" })}</th>
                      <th>{t({ de: "Runtime / Modell", en: "Runtime / model" })}</th>
                      <th>Runs</th>
                      <th>{t({ de: "Erfüllungsquote", en: "Pass rate" })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.comparisons.map((c) => (
                      <tr key={`${c.rubricId}:${c.agentId}:${c.runtimeType}:${c.model}`}>
                        <td>
                          {data.rubrics.find((r) => r.id === c.rubricId)?.title ?? c.rubricId} · v
                          {data.rubrics.find((r) => r.id === c.rubricId)?.version ?? "?"}
                        </td>
                        <td>{c.agentName}</td>
                        <td>
                          {c.runtimeType} /{" "}
                          {c.model ?? t({ de: "Standardmodell nicht erfasst", en: "Default model not recorded" })}
                        </td>
                        <td>{c.runCount}</td>
                        <td>{c.score.toLocaleString(locale)} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section aria-label={t({ de: "Auswertungsverlauf", en: "Evaluation history" })}>
            <h3>{t({ de: "Nachweise und Einzelresultate", en: "Evidence and individual results" })}</h3>
            {data.measurements.map((m) => (
              <details key={m.id}>
                <summary>
                  {m.run.agentName} · {m.run.taskTitle} · {m.passedCases}/{m.totalCases}{" "}
                  {t({ de: "erfüllt ·", en: "passed ·" })} {m.score.toLocaleString(locale)} %
                </summary>
                <p>
                  Run: <code>{m.run.id}</code> · Runtime: {m.run.runtimeType} {t({ de: "· Modell:", en: "· Model:" })}{" "}
                  {m.run.model ?? t({ de: "nicht erfasst", en: "not recorded" })}
                </p>
                <p>
                  {t({ de: "Erfasst:", en: "Recorded:" })} {new Date(m.createdAt).toLocaleString(locale)}{" "}
                  {t({ de: "· Bewertet durch:", en: "· Evaluated by:" })} {m.createdBy} · Engine v{m.engineVersion}
                </p>
                <p>
                  {t({ de: "Rubrik-Hash:", en: "Rubric hash:" })} <code>{m.rubricHash}</code>
                  <br />
                  {t({ de: "Nachweis-Hash:", en: "Evidence hash:" })} <code>{m.evidenceHash}</code>
                </p>
                <ul>
                  {m.checks.map((c) => (
                    <li key={c.caseId}>
                      <strong>
                        {c.passed ? t({ de: "Erfüllt", en: "Passed" }) : t({ de: "Nicht erfüllt", en: "Failed" })}:{" "}
                        {c.label}
                      </strong>{" "}
                      — {c.observed}
                    </li>
                  ))}
                </ul>
                <button disabled={busy} onClick={() => void replay(m)}>
                  {t({ de: "Nachweis reproduzieren", en: "Reproduce evidence" })}{" "}
                </button>
              </details>
            ))}
          </section>
          <section aria-label={t({ de: "Rubrikverlauf", en: "Rubric history" })}>
            <h3>{t({ de: "Unveränderliche Rubrikversionen", en: "Immutable rubric versions" })}</h3>
            {data.rubrics.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.title} · v{r.version} · {r.cases.length} {t({ de: "Prüfungen", en: "Checks" })}{" "}
                </summary>
                <p>
                  {r.reason} · {new Date(r.createdAt).toLocaleString(locale)} · {r.createdBy}
                </p>
                <ol>
                  {r.cases.map((c) => (
                    <li key={c.id}>
                      {c.label}:{" "}
                      {c.kind === "json_field"
                        ? `${c.path.join(".")} → ${c.valueType}`
                        : `${c.kind === "contains" ? t({ de: "enthält", en: "contains" }) : t({ de: "enthält nicht", en: "does not contain" })} „${c.expected}“`}
                    </li>
                  ))}
                </ol>
                {data.canEdit && (
                  <button disabled={busy} onClick={() => edit(r)}>
                    Version {r.version} {t({ de: "überarbeiten", en: "revise" })}{" "}
                  </button>
                )}
              </details>
            ))}
          </section>
          <p className="objective-note">
            {t({
              de: "Anzeige: letzte 200 Rubrikversionen, Runs und Messungen; bis zu 500 Vergleichsgruppen. Vergleichswerte umfassen alle gespeicherten Messungen ihrer Gruppe.",
              en: "Showing the latest 200 rubric versions, runs and measurements; up to 500 comparison groups. Comparison values include all stored measurements in their group.",
            })}{" "}
          </p>
        </>
      )}
    </section>
  );
}
