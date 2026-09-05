import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson as request } from "./panel-api";
import type {
  CoachingCase,
  CoachingCaseKind,
  CoachingNote,
  CoachingProposal,
  CoachingSnapshot,
} from "../shared/coaching";
import "./CoachingPanel.css";

const CASE_LABELS: Record<CoachingCaseKind, string> = {
  guidance_contains: "Guidance enthält Text",
  guidance_excludes: "Guidance vermeidet Text",
  skill_present: "Installierte Skill-Referenz gewählt",
  run_succeeded: "Gespeicherter Run abgeschlossen",
  run_output_contains: "Gespeichertes Ergebnis enthält Text",
};
const NOTE_LABELS = { one_on_one: "1-on-1", retrospective: "Retrospektive", lesson: "Lesson Learned" };
const STATUS_LABELS = {
  draft: "Entwurf",
  ready: "Bereit zur Freigabe",
  failed: "Prüfung fehlgeschlagen",
  applied: "Übernommen",
  rejected: "Abgelehnt",
};
const newCase = (): CoachingCase => ({ label: "", kind: "guidance_contains", expected: "" });
interface Props {
  agents: Array<{ id: string; displayName: string }>;
  canReview?: boolean;
  canEdit?: boolean;
  refreshKey?: number;
}
export function CoachingPanel({ agents, canReview = true, canEdit = true, refreshKey }: Props): React.JSX.Element {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [snapshot, setSnapshot] = useState<CoachingSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [guidance, setGuidance] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [cases, setCases] = useState<CoachingCase[]>([newCase()]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [noteKind, setNoteKind] = useState<CoachingNote["kind"]>("one_on_one");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [noteRun, setNoteRun] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!agentId) return;
    const token = ++generation.current;
    setLoading(true);
    try {
      const data = await request<CoachingSnapshot>(`/api/crew/coaching?agentId=${encodeURIComponent(agentId)}`);
      if (token === generation.current) setSnapshot(data);
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : "Coaching konnte nicht geladen werden.");
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [agentId]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    if (refreshKey !== undefined) void load();
  }, [refreshKey, load]);
  useEffect(() => {
    setSnapshot(null);
    setError("");
    setNotice("");
    setTitle("");
    setGuidance("");
    setSkills([]);
    setCases([newCase()]);
    setReason({});
    setNoteTitle("");
    setNoteBody("");
    setNoteRun("");
    void load();
    return invalidate;
  }, [load, invalidate]);
  const mutate = async (action: () => Promise<unknown>, message: string, reset?: () => void) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      reset?.();
      setNotice(message);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Änderung konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };
  const patchCase = (index: number, patch: Partial<CoachingCase>) =>
    setCases((values) => values.map((value, i) => (i === index ? { ...value, ...patch } : value)));
  const saveProposal = () =>
    mutate(
      () =>
        request("/api/crew/coaching/proposals", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            title,
            guidance,
            skills,
            cases: cases.map((c) => ({
              label: c.label,
              kind: c.kind,
              ...(c.kind !== "run_succeeded" ? { expected: c.expected } : {}),
              ...(c.kind.startsWith("run_") ? { runId: c.runId } : {}),
            })),
          }),
        }),
      "Vorschlag gespeichert. Jetzt auswerten und anschließend menschlich prüfen.",
      () => {
        setTitle("");
      },
    );
  const review = (proposal: CoachingProposal, decision: "approve" | "reject") =>
    mutate(
      () =>
        request(`/api/crew/coaching/proposals/${proposal.id}/review`, {
          method: "POST",
          body: JSON.stringify({ decision, reason: reason[proposal.id] ?? "" }),
        }),
      decision === "approve"
        ? "Neue Guidance-Version freigegeben. Sie gilt ab dem nächsten Run."
        : "Vorschlag abgelehnt. Die aktive Guidance bleibt bestehen.",
    );
  return (
    <section className="coaching-panel" aria-label="Coaching und Evaluationen" aria-busy={busy || loading}>
      <header>
        <h2>Coaching &amp; Evaluationen</h2>
        <p>Konkrete Beobachtungen festhalten, Änderungen prüfen und bewusst freigeben.</p>
      </header>
      <label>
        Agent
        <select value={agentId} disabled={busy} onChange={(event) => setAgentId(event.target.value)}>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.displayName}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Coaching-Verlauf wird geladen …</p>}
      {!agentId && <p>Noch keine Agenten vorhanden.</p>}
      {agentId && !loading && !snapshot && (
        <button type="button" className="ic-btn" onClick={() => void load()}>
          Erneut laden
        </button>
      )}
      {snapshot && (
        <>
          <section className="coaching-section">
            <h3>Aktive Guidance · Version {snapshot.current?.version ?? 0}</h3>
            <p>
              {snapshot.current
                ? `Freigegeben am ${new Date(snapshot.current.createdAt).toLocaleString("de-DE")} · ${snapshot.current.approvedBy}`
                : "Es gilt die bestehende professionelle Rolle. Noch keine Coaching-Ergänzung freigegeben."}
            </p>
            {snapshot.current && (
              <>
                <pre>{snapshot.current.guidance}</pre>
                <p>Skill-Referenzen: {snapshot.current.skills.join(", ") || "keine"}</p>
              </>
            )}
            <p className="coaching-help">
              Guidance ergänzt die Arbeitsweise. Sie ändert keine Rolle, Persona, Tools, Berechtigungen oder Seniorität.
            </p>
          </section>
          {canEdit && (
            <details className="coaching-section">
              <summary>Guidance-Änderung vorschlagen</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveProposal();
                }}
              >
                <label>
                  Titel
                  <input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label>
                  Vollständige neue Coaching-Guidance
                  <textarea
                    required
                    maxLength={12000}
                    rows={6}
                    value={guidance}
                    onChange={(event) => setGuidance(event.target.value)}
                  />
                </label>
                {snapshot.current && (
                  <button
                    className="ic-btn"
                    type="button"
                    onClick={() => {
                      setGuidance(snapshot.current!.guidance);
                      setSkills(snapshot.current!.skills.filter((skill) => snapshot.skills.includes(skill)));
                    }}
                  >
                    Aktive Version als Ausgangspunkt laden
                  </button>
                )}
                <fieldset>
                  <legend>Bereits installierte Skills</legend>
                  {snapshot.skills.length === 0 ? (
                    <p>Keine installierten Skills. Hier werden keine Pakete nachgeladen.</p>
                  ) : (
                    snapshot.skills.map((skill) => (
                      <label className="coaching-check" key={skill}>
                        <input
                          type="checkbox"
                          checked={skills.includes(skill)}
                          onChange={(event) =>
                            setSkills((old) =>
                              event.target.checked ? [...old, skill] : old.filter((v) => v !== skill),
                            )
                          }
                        />
                        {skill}
                      </label>
                    ))
                  )}
                </fieldset>
                <fieldset>
                  <legend>Deterministische Prüfkriterien</legend>
                  <p className="coaching-help">
                    Text- und Statusprüfungen sind messbare Bedingungen, keine Genauigkeitsnote. Bestehende
                    Run-Nachweise belegen vergangene Arbeit, nicht die Wirksamkeit einer noch nicht eingesetzten
                    Guidance.
                  </p>
                  {cases.map((check, index) => (
                    <div className="coaching-case" key={index}>
                      <label>
                        Prüfung {index + 1}: Bezeichnung
                        <input
                          required
                          maxLength={160}
                          value={check.label}
                          onChange={(event) => patchCase(index, { label: event.target.value })}
                        />
                      </label>
                      <label>
                        Prüfung {index + 1}: Typ
                        <select
                          value={check.kind}
                          onChange={(event) => patchCase(index, { kind: event.target.value as CoachingCaseKind })}
                        >
                          {Object.entries(CASE_LABELS).map(([value, label]) => (
                            <option value={value} key={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {check.kind !== "run_succeeded" && (
                        <label>
                          Prüfung {index + 1}: Erwarteter Text oder Skill
                          <input
                            required
                            maxLength={1000}
                            value={check.expected ?? ""}
                            onChange={(event) => patchCase(index, { expected: event.target.value })}
                          />
                        </label>
                      )}
                      {check.kind.startsWith("run_") && (
                        <label>
                          Prüfung {index + 1}: Run-ID
                          <input
                            required
                            maxLength={100}
                            value={check.runId ?? ""}
                            onChange={(event) => patchCase(index, { runId: event.target.value })}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        className="ic-btn"
                        disabled={cases.length === 1}
                        onClick={() => setCases((old) => old.filter((_, i) => i !== index))}
                      >
                        Prüfung {index + 1} entfernen
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="ic-btn"
                    disabled={cases.length >= 30}
                    onClick={() => setCases((old) => [...old, newCase()])}
                  >
                    Prüfung hinzufügen
                  </button>
                </fieldset>
                <button className="ic-btn" type="submit" disabled={busy}>
                  Vorschlag speichern
                </button>
              </form>
            </details>
          )}
          <section className="coaching-section">
            <h3>Vorschläge und Ergebnisse</h3>
            {snapshot.proposals.length === 0 && (
              <p>Noch keine Vorschläge. Eine Beobachtung aus dem nächsten Review kann der Ausgangspunkt sein.</p>
            )}
            {snapshot.proposals.map((proposal) => (
              <article key={proposal.id} className="coaching-entry">
                <h4>
                  {proposal.title} · {STATUS_LABELS[proposal.status]}
                </h4>
                <p>
                  Basisversion {proposal.baseVersion} · {new Date(proposal.createdAt).toLocaleString("de-DE")} ·{" "}
                  {proposal.createdBy}
                </p>
                <details>
                  <summary>Änderung und Kriterien ansehen</summary>
                  <pre>{proposal.guidance}</pre>
                  <p>Skill-Referenzen: {proposal.skills.join(", ") || "keine"}</p>
                  <ul>
                    {proposal.cases.map((check, index) => (
                      <li key={index}>
                        {check.label}: {CASE_LABELS[check.kind]} {check.expected && `„${check.expected}“`}{" "}
                        {check.runId && `· Run ${check.runId}`}
                      </li>
                    ))}
                  </ul>
                </details>
                {proposal.evaluation && (
                  <div>
                    <p>
                      <strong>
                        {proposal.evaluation.passedCases} von {proposal.evaluation.totalCases} Kriterien bestanden
                      </strong>{" "}
                      · {new Date(proposal.evaluation.createdAt).toLocaleString("de-DE")}
                    </p>
                    <ul>
                      {proposal.evaluation.checks.map((check, index) => (
                        <li key={index}>
                          {check.passed ? "Bestanden" : "Nicht bestanden"}: {check.label} — {check.observed}
                          {check.evidenceHash && (
                            <details>
                              <summary>Gespeicherter Run-Nachweis</summary>
                              <p>Run: {check.runId}</p>
                              <code>SHA-256: {check.evidenceHash}</code>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {canEdit && !["applied", "rejected"].includes(proposal.status) && (
                  <button
                    type="button"
                    className="ic-btn"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          request(`/api/crew/coaching/proposals/${proposal.id}/evaluate`, {
                            method: "POST",
                            body: "{}",
                          }),
                        "Auswertung gespeichert. Alle Ergebnisse sind im Vorschlag sichtbar.",
                      )
                    }
                  >
                    Kriterien auswerten
                  </button>
                )}
                {canReview && !["applied", "rejected"].includes(proposal.status) && (
                  <div className="coaching-review">
                    <label>
                      Begründung für „{proposal.title}“
                      <textarea
                        required
                        maxLength={4000}
                        value={reason[proposal.id] ?? ""}
                        onChange={(event) => setReason((old) => ({ ...old, [proposal.id]: event.target.value }))}
                      />
                    </label>
                    <button
                      className="ic-btn"
                      type="button"
                      disabled={busy || proposal.status !== "ready" || !reason[proposal.id]?.trim()}
                      onClick={() => void review(proposal, "approve")}
                    >
                      Freigeben und übernehmen
                    </button>
                    <button
                      className="ic-btn"
                      type="button"
                      disabled={busy || !reason[proposal.id]?.trim()}
                      onClick={() => void review(proposal, "reject")}
                    >
                      Ablehnen
                    </button>
                  </div>
                )}
                {proposal.reviewedBy && (
                  <p>
                    Entscheidung von {proposal.reviewedBy}: {proposal.reviewReason}
                  </p>
                )}
              </article>
            ))}
          </section>
          <section className="coaching-section">
            <h3>1-on-1, Retrospektiven und Lessons Learned</h3>
            {canEdit && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(
                    () =>
                      request("/api/crew/coaching/notes", {
                        method: "POST",
                        body: JSON.stringify({
                          agentId,
                          kind: noteKind,
                          title: noteTitle,
                          body: noteBody,
                          ...(noteRun.trim() ? { runId: noteRun.trim() } : {}),
                        }),
                      }),
                    "Beobachtung gespeichert. Sie verändert die Guidance nicht automatisch.",
                    () => {
                      setNoteTitle("");
                      setNoteBody("");
                      setNoteRun("");
                    },
                  );
                }}
              >
                <label>
                  Art
                  <select
                    value={noteKind}
                    onChange={(event) => setNoteKind(event.target.value as CoachingNote["kind"])}
                  >
                    {Object.entries(NOTE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Titel der Beobachtung
                  <input
                    required
                    maxLength={200}
                    value={noteTitle}
                    onChange={(event) => setNoteTitle(event.target.value)}
                  />
                </label>
                <label>
                  Beobachtung, Vereinbarungen und nächste Schritte
                  <textarea
                    required
                    rows={4}
                    maxLength={12000}
                    value={noteBody}
                    onChange={(event) => setNoteBody(event.target.value)}
                  />
                </label>
                <label>
                  Run-ID als Quelle (optional)
                  <input maxLength={100} value={noteRun} onChange={(event) => setNoteRun(event.target.value)} />
                </label>
                <button className="ic-btn" type="submit" disabled={busy}>
                  Beobachtung speichern
                </button>
              </form>
            )}
            {snapshot.notes.length === 0 && <p>Noch keine Beobachtungen gespeichert.</p>}
            {snapshot.notes.map((note) => (
              <article className="coaching-entry" key={note.id}>
                <h4>
                  {NOTE_LABELS[note.kind]} · {note.title}
                </h4>
                <p>
                  {new Date(note.createdAt).toLocaleString("de-DE")} · {note.createdBy}
                  {note.runId && ` · Run ${note.runId}`}
                </p>
                <pre>{note.body}</pre>
              </article>
            ))}
          </section>
          <details className="coaching-section">
            <summary>Versionsverlauf ({snapshot.versions.length})</summary>
            {snapshot.versions.map((version) => (
              <article className="coaching-entry" key={version.version}>
                <h4>Version {version.version}</h4>
                <p>
                  {new Date(version.createdAt).toLocaleString("de-DE")} · {version.approvedBy} · Vorschlag{" "}
                  {version.proposalId}
                </p>
                <pre>{version.guidance}</pre>
                <p>Skill-Referenzen: {version.skills.join(", ") || "keine"}</p>
              </article>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
