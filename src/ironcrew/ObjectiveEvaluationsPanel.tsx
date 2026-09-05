import { useCallback, useEffect, useRef, useState } from "react";
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
        setError(cause instanceof Error ? cause.message : "Auswertungen konnten nicht geladen werden.");
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, []);
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
      setError(cause instanceof Error ? cause.message : "Aktion fehlgeschlagen. Entwurf bleibt erhalten.");
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
    mutate(async () => {
      const replayed = await requestJson<{ checks: ObjectiveMeasurement["checks"] }>(
        `/api/crew/evaluations/${encodeURIComponent(measurement.id)}/replay`,
      );
      if (JSON.stringify(replayed.checks) !== JSON.stringify(measurement.checks))
        throw new Error("Wiederholung weicht vom gespeicherten Ergebnis ab.");
    }, "Gespeicherter Nachweis reproduziert: alle Einzelresultate stimmen überein.");
  return (
    <section className="objective-panel" aria-label="Objektive Tests">
      <header>
        <div>
          <p className="objective-eyebrow">Qualität mit Nachweis</p>
          <h2>Objektive Tests</h2>
        </div>
        <button type="button" disabled={loading || busy} onClick={() => void load()}>
          Aktualisieren
        </button>
      </header>
      <p>
        Prüfe gespeicherte Arbeitsergebnisse mit festen Kriterien. Die Erfüllungsquote ist getrennt von den 1–5 Sternen
        des Leads und ändert keine Mitarbeiterrolle.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && !data && <p role="status">Rubriken und Run-Nachweise werden geladen …</p>}
      {data && (
        <>
          <div className="objective-workspace">
            <section aria-label="Test ausführen">
              <h3>Gespeicherten Run prüfen</h3>
              <p>
                Es startet kein Modellaufruf. Jede Rubrikversion bewertet einen Run einmal; Wiederholung nutzt denselben
                Nachweis.
              </p>
              <label>
                Rubrikversion
                <select value={rubricId} onChange={(e) => setRubricId(e.target.value)}>
                  <option value="">Rubrik auswählen</option>
                  {data.rubrics.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title} · v{r.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Abgeschlossener Run
                <select value={runId} onChange={(e) => setRunId(e.target.value)}>
                  <option value="">Run auswählen</option>
                  {data.runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.agentName} · {r.taskTitle} · {r.runtimeType}/{r.model ?? "Standardmodell nicht erfasst"} ·{" "}
                      {r.id}
                    </option>
                  ))}
                </select>
              </label>
              {!data.runs.length && (
                <p>
                  Noch kein abgeschlossener Run vorhanden. Führe zuerst eine Aufgabe mit einer eingerichteten Runtime
                  aus.
                </p>
              )}
              {!data.rubrics.length && (
                <p>Noch keine Rubrik vorhanden. Der Owner legt zuerst überprüfbare Abnahmekriterien an.</p>
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
                    "Auswertung gespeichert.",
                  )
                }
              >
                Run auswerten
              </button>
              {!data.canMeasure && <p>Auswertungen starten können Owner und Operatoren.</p>}
            </section>
            {data.canEdit && (
              <form
                aria-label="Rubrik bearbeiten"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate(async () => {
                    const result = await requestJson<{ rubric: ObjectiveRubric }>("/api/crew/evaluations/rubrics", {
                      method: "POST",
                      body: JSON.stringify({ key, baseVersion, title, reason, cases }),
                    });
                    setRubricId(result.rubric.id);
                    edit(result.rubric);
                  }, "Unveränderliche Rubrikversion gespeichert.");
                }}
              >
                <h3>{baseVersion ? `Rubrik überarbeiten · Basis v${baseVersion}` : "Neue Rubrik"}</h3>
                <label>
                  Rubrikkennung
                  <input
                    required
                    pattern="[a-z][a-z0-9_-]{0,63}"
                    maxLength={64}
                    value={key}
                    disabled={baseVersion > 0}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="beispiel-qualitaet"
                  />
                </label>
                <label>
                  Titel
                  <input required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label>
                  Änderungsgrund
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
                    <legend>Prüfung {index + 1}</legend>
                    <label>
                      Bezeichnung
                      <input
                        required
                        maxLength={160}
                        value={c.label}
                        onChange={(e) => patchCase(index, { ...c, label: e.target.value })}
                      />
                    </label>
                    <label>
                      Prüfart
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
                        <option value="contains">Enthält Text</option>
                        <option value="excludes">Enthält keinen Text</option>
                        <option value="json_field">JSON-Feld hat Typ</option>
                      </select>
                    </label>
                    {c.kind === "json_field" ? (
                      <>
                        <label>
                          Feldpfad (durch Punkt getrennt)
                          <input
                            required
                            value={c.path.join(".")}
                            onChange={(e) => patchCase(index, { ...c, path: e.target.value.split(".") })}
                          />
                        </label>
                        <label>
                          Erwarteter Typ
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
                        Vergleichstext
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
                        Prüfung {index + 1} entfernen
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
                    Prüfung hinzufügen
                  </button>
                  <button type="submit" disabled={busy}>
                    Rubrikversion speichern
                  </button>
                  <button type="button" disabled={busy} onClick={() => edit()}>
                    Neue Rubrik beginnen
                  </button>
                </div>
                <p>
                  Textprüfungen beachten Groß-/Kleinschreibung. JSON-Prüfungen erwarten reines JSON. Kein Code und keine
                  regulären Ausdrücke werden ausgeführt.
                </p>
              </form>
            )}
          </div>
          <section aria-label="Modellvergleich">
            <h3>Vergleich nach Rubrikversion</h3>
            <p>
              Gleiche Kriterien machen Ergebnisse nachvollziehbar. Unterschiedliche Aufgaben bleiben unterschiedlich
              schwer; diese Quote ist kein allgemeines Modellranking. Unbekannte Standardmodelle werden ausdrücklich
              ausgewiesen.
            </p>
            {!data.comparisons.length ? (
              <p>Noch keine gemessenen Ergebnisse. Es werden keine Beispielwerte angezeigt.</p>
            ) : (
              <div className="objective-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rubrik</th>
                      <th>Mitarbeiter</th>
                      <th>Runtime / Modell</th>
                      <th>Runs</th>
                      <th>Erfüllungsquote</th>
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
                          {c.runtimeType} / {c.model ?? "Standardmodell nicht erfasst"}
                        </td>
                        <td>{c.runCount}</td>
                        <td>{c.score.toLocaleString("de-DE")} %</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section aria-label="Auswertungsverlauf">
            <h3>Nachweise und Einzelresultate</h3>
            {data.measurements.map((m) => (
              <details key={m.id}>
                <summary>
                  {m.run.agentName} · {m.run.taskTitle} · {m.passedCases}/{m.totalCases} erfüllt ·{" "}
                  {m.score.toLocaleString("de-DE")} %
                </summary>
                <p>
                  Run: <code>{m.run.id}</code> · Runtime: {m.run.runtimeType} · Modell: {m.run.model ?? "nicht erfasst"}
                </p>
                <p>
                  Erfasst: {new Date(m.createdAt).toLocaleString("de-DE")} · Bewertet durch: {m.createdBy} · Engine v
                  {m.engineVersion}
                </p>
                <p>
                  Rubrik-Hash: <code>{m.rubricHash}</code>
                  <br />
                  Nachweis-Hash: <code>{m.evidenceHash}</code>
                </p>
                <ul>
                  {m.checks.map((c) => (
                    <li key={c.caseId}>
                      <strong>
                        {c.passed ? "Erfüllt" : "Nicht erfüllt"}: {c.label}
                      </strong>{" "}
                      — {c.observed}
                    </li>
                  ))}
                </ul>
                <button disabled={busy} onClick={() => void replay(m)}>
                  Nachweis reproduzieren
                </button>
              </details>
            ))}
          </section>
          <section aria-label="Rubrikverlauf">
            <h3>Unveränderliche Rubrikversionen</h3>
            {data.rubrics.map((r) => (
              <details key={r.id}>
                <summary>
                  {r.title} · v{r.version} · {r.cases.length} Prüfungen
                </summary>
                <p>
                  {r.reason} · {new Date(r.createdAt).toLocaleString("de-DE")} · {r.createdBy}
                </p>
                <ol>
                  {r.cases.map((c) => (
                    <li key={c.id}>
                      {c.label}:{" "}
                      {c.kind === "json_field"
                        ? `${c.path.join(".")} → ${c.valueType}`
                        : `${c.kind === "contains" ? "enthält" : "enthält nicht"} „${c.expected}“`}
                    </li>
                  ))}
                </ol>
                {data.canEdit && (
                  <button disabled={busy} onClick={() => edit(r)}>
                    Version {r.version} überarbeiten
                  </button>
                )}
              </details>
            ))}
          </section>
          <p className="objective-note">
            Anzeige: letzte 200 Rubrikversionen, Runs und Messungen; bis zu 500 Vergleichsgruppen. Vergleichswerte
            umfassen alle gespeicherten Messungen ihrer Gruppe.
          </p>
        </>
      )}
    </section>
  );
}
