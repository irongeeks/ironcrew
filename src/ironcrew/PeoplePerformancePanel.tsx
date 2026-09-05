import { CAREER_FALLBACK_REVIEWER_ROLES } from "../shared/career";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CareerSnapshot, CareerReview, RatingAggregate, CareerFilters } from "../shared/career";
import type { RoutingSnapshot } from "../shared/routing-profiles";
import { isApiRequestError } from "../api/core";
import { requestJson as request } from "./panel-api";
import "./PeoplePerformancePanel.css";

interface Person {
  id: string;
  displayName: string;
  departmentId: string | null;
  professionalRole?: string;
}
interface Department {
  id: string;
  name: string;
}
interface Props {
  agents: Person[];
  departments: Department[];
  canManage?: boolean;
  refreshKey?: number;
  onOpenRouting?: () => void;
}
const LEVELS = { junior: "Junior", senior: "Senior", lead: "Lead" } as const;
const DIFFICULTIES = { simple: "Einfach", normal: "Normal", complex: "Komplex" } as const;
const PROFESSIONAL_ROLE_NAMES: Record<string, string> = {
  executive_assistant: "Executive Assistant",
  chief_operating_officer: "Betriebsleitung · COO",
  chief_technology_officer: "Technische Leitung · CTO",
  head_of_infrastructure: "Infrastrukturleitung",
  chief_information_security_officer: "Informationssicherheit · CISO",
  finance_and_bookkeeping_lead: "Finanzen & Buchhaltung",
  legal_and_contracts: "Recht & Verträge",
  research_and_intelligence: "Recherche & Analyse",
  qa_root_cause_red_team: "Qualitätssicherung & Fehleranalyse",
  quality_assurance: "Qualitätssicherung",
  ui_ux_and_brand: "Design & Marke",
  marketing_and_messaging: "Marketing & Kommunikation",
  sales_and_negotiation: "Vertrieb & Verhandlung",
  knowledge_and_documentation: "Wissen & Dokumentation",
  automation_and_tools: "Automatisierung & Werkzeuge",
};
const roleName = (role: string | undefined) =>
  role
    ? Object.hasOwn(PROFESSIONAL_ROLE_NAMES, role)
      ? PROFESSIONAL_ROLE_NAMES[role]
      : role.replaceAll("_", " ")
    : "";
const FALLBACK_REVIEW_ROLES = new Set<string>(CAREER_FALLBACK_REVIEWER_ROLES);
const displayTime = (value: number) => new Date(value).toLocaleString("de-DE");
const average = (value: number | null) =>
  value === null ? "–" : value.toLocaleString("de-DE", { maximumFractionDigits: 2 });

function Distribution({ value }: { value: RatingAggregate }) {
  return (
    <dl className="people-distribution" aria-label="Verteilung von 1 bis 5 Sternen">
      {([1, 2, 3, 4, 5] as const).map((score) => (
        <div key={score}>
          <dt>{score}</dt>
          <dd>
            <meter
              aria-label={`${score} Sterne`}
              min={0}
              max={Math.max(1, value.count)}
              value={value.distribution[score]}
            />
          </dd>
          <dd className="people-number">{value.distribution[score]}</dd>
        </div>
      ))}
    </dl>
  );
}

function RatingsTable({
  rows,
  title,
  label,
}: {
  rows: RatingAggregate[];
  title: string;
  label: (key: string) => string;
}) {
  return (
    <section className="people-section">
      <h3>{title}</h3>
      {!rows.length ? (
        <p className="people-help">– Noch keine Bewertungen für diese Auswahl.</p>
      ) : (
        <div className="people-table-scroll">
          <table>
            <caption className="ic-sr-only">{title}: aktuelle Bewertungen, keine mehrfach gezählten Revisionen</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Ø Sterne</th>
                <th scope="col">Anzahl</th>
                <th scope="col">Verteilung 1–5</th>
                <th scope="col">Schwierigkeit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{label(row.key)}</th>
                  <td className="people-average people-number">{average(row.mean)}</td>
                  <td className="people-number">{row.count}</td>
                  <td>
                    <Distribution value={row} />
                  </td>
                  <td>
                    {Object.entries(DIFFICULTIES).map(([key, name]) => (
                      <div key={key}>
                        {name}: {row.complexity[key as keyof typeof DIFFICULTIES]}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewHistory({ reviews, agentName }: { reviews: CareerReview[]; agentName: (id: string) => string }) {
  return (
    <section className="people-section">
      <h3>Aufgabenbewertungen &amp; Revisionen</h3>
      {!reviews.length && (
        <p className="people-help">
          Noch keine Bewertungen. Ein abgeschlossener Arbeits-Run und ein unabhängiger Lead-Review sind erforderlich.
        </p>
      )}
      <div className="people-history">
        {reviews.map((review) => (
          <article key={review.id}>
            <h4>
              {agentName(review.agentId)} · <span className="people-average">{review.score} / 5 Sterne</span>
            </h4>
            <p className="people-help">
              {DIFFICULTIES[review.difficulty]} · Revision {review.revision} ·{" "}
              {review.isCurrent ? "Aktuelle Bewertung" : "Historisch – nicht im Durchschnitt"}
            </p>
            <pre>{review.rationale}</pre>
            <dl className="people-review-meta">
              <div>
                <dt>Reviewer</dt>
                <dd>{agentName(review.reviewerAgentId)}</dd>
              </div>
              <div>
                <dt>Zeitpunkt</dt>
                <dd>{displayTime(review.createdAt)}</dd>
              </div>
              <div>
                <dt>Modell des Arbeits-Runs</dt>
                <dd>
                  {review.model ?? "Modell nicht erfasst"} · {review.runtimeType}
                </dd>
              </div>
              <div>
                <dt>Aufgabe</dt>
                <dd>
                  <code>{review.taskId}</code>
                </dd>
              </div>
            </dl>
            <details>
              <summary>Run-Nachweise und Bewertungsrubrik</summary>
              <p>
                Rubrik-Version {review.rubricVersion} · Reviewer-Modell: {review.reviewerModel ?? "nicht erfasst"} ·{" "}
                {review.reviewerRuntimeType}
              </p>
              <p>Reviewer-Vessel: {review.reviewerVesselId ?? "–"}</p>
              <dl className="people-review-meta">
                <div>
                  <dt>Arbeits-Run</dt>
                  <dd>
                    <code>{review.workRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Review-Run</dt>
                  <dd>
                    <code>{review.reviewRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Vessel des Arbeits-Runs</dt>
                  <dd>{review.vesselId || "–"}</dd>
                </div>
              </dl>
              <p>
                Richtigkeit: {review.rubricDimensions.correctness}/5 · Vollständigkeit:{" "}
                {review.rubricDimensions.completeness}/5 · Qualität: {review.rubricDimensions.quality}/5
              </p>
              {review.evidence.length ? (
                <ul>
                  {review.evidence.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              ) : (
                <p>Keine zusätzlichen Nachweise angegeben.</p>
              )}
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

function DepartmentSetup({
  snapshot,
  agents,
  departments,
  busy,
  save,
}: {
  snapshot: CareerSnapshot;
  agents: Person[];
  departments: Department[];
  busy: boolean;
  save: (body: {
    baseRevision: number;
    enabled: boolean;
    departments: CareerSnapshot["config"]["departments"];
  }) => void;
}) {
  const [enabled, setEnabled] = useState(snapshot.config.enabled);
  const [rows, setRows] = useState(() =>
    departments.map(
      (department) =>
        snapshot.config.departments.find((row) => row.departmentId === department.id) ?? {
          departmentId: department.id,
          enabled: false,
          leadAgentId: null,
          fallbackReviewerAgentId: null,
        },
    ),
  );
  const patch = (id: string, value: Partial<(typeof rows)[number]>) =>
    setRows((current) => current.map((row) => (row.departmentId === id ? { ...row, ...value } : row)));
  const leads = agents.filter(
    (agent) => snapshot.profiles.find((profile) => profile.agentId === agent.id)?.level === "lead",
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save({ baseRevision: snapshot.config.revision, enabled, departments: rows });
      }}
    >
      <fieldset disabled={busy}>
        <legend>Abteilungsleitung &amp; Delegation</legend>
        <label className="people-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Lead-Delegation und Aufgabenbewertung aktivieren
        </label>
        <p className="people-help">
          Der Lead verteilt Aufgaben nach Schwierigkeit. Bewertungen benötigen einen unabhängigen Reviewer; keine
          Selbstbewertung. Eigene Lead-Arbeit prüft ein unabhängiger QA-/COO-Reviewer. Level und fachliche Rolle bleiben
          getrennt.
        </p>
        <p className="people-help">
          Für eine neue Abteilungsleitung zuerst die Laufbahnstufe Lead anfragen und in den Freigaben bestätigen;
          anschließend hier zuweisen.
        </p>
        {!departments.length && <p>Noch keine Abteilungen vorhanden.</p>}
        {rows.map((row) => (
          <fieldset key={row.departmentId}>
            <legend>
              {departments.find((department) => department.id === row.departmentId)?.name ?? row.departmentId}
            </legend>
            <label className="people-check">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) => patch(row.departmentId, { enabled: event.target.checked })}
              />
              Delegation für diese Abteilung
            </label>
            <div className="people-fields">
              <label>
                Abteilungslead
                <select
                  value={row.leadAgentId ?? ""}
                  onChange={(event) => patch(row.departmentId, { leadAgentId: event.target.value || null })}
                >
                  <option value="">Nicht zugewiesen</option>
                  {leads
                    .filter((agent) => agent.departmentId === row.departmentId)
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Unabhängiger Ersatzreviewer
                <select
                  value={row.fallbackReviewerAgentId ?? ""}
                  onChange={(event) => patch(row.departmentId, { fallbackReviewerAgentId: event.target.value || null })}
                >
                  <option value="">Nicht zugewiesen</option>
                  {agents
                    .filter(
                      (agent) =>
                        agent.id !== row.leadAgentId && FALLBACK_REVIEW_ROLES.has(agent.professionalRole ?? ""),
                    )
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.displayName}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </fieldset>
        ))}
        <button className="ic-btn ic-btn--primary" type="submit">
          Abteilungssteuerung speichern
        </button>
      </fieldset>
    </form>
  );
}

function LevelSetup({
  snapshot,
  agents,
  busy,
  save,
}: {
  snapshot: CareerSnapshot;
  agents: Person[];
  busy: boolean;
  save: (id: string, body: { baseRevision: number; level: "junior" | "senior" | "lead"; reason: string }) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [level, setLevel] = useState<"junior" | "senior" | "lead">(
    snapshot.profiles.find((row) => row.agentId === agents[0]?.id)?.level ?? "junior",
  );
  const [reason, setReason] = useState("");
  const profile = snapshot.profiles.find((row) => row.agentId === agentId);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (profile) save(agentId, { baseRevision: profile.revision, level, reason: reason.trim() });
      }}
    >
      <fieldset disabled={busy || !agents.length}>
        <legend>Mitarbeiterlevel ändern</legend>
        <div className="people-fields">
          <label>
            Mitarbeiter
            <select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setLevel(snapshot.profiles.find((row) => row.agentId === event.target.value)?.level ?? "junior");
                setReason("");
              }}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Neues Level
            <select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}>
              {Object.entries(LEVELS).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="people-help">
          Aktuell: {profile ? LEVELS[profile.level] : "–"}. Die Änderung wird als Freigabe angefragt. Rollen, Tools und
          Modellkonfiguration werden dadurch nicht ersetzt.
        </p>
        <label>
          Begründung
          <textarea value={reason} required maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </label>
        <button
          type="submit"
          className="ic-btn"
          disabled={
            !profile ||
            profile.level === level ||
            !reason.trim() ||
            snapshot.pendingChanges.some((change) => change.agentId === agentId && change.status === "pending")
          }
        >
          Leveländerung zur Freigabe anfragen
        </button>
      </fieldset>
    </form>
  );
}

export function PeoplePerformancePanel({
  agents,
  departments,
  canManage = false,
  refreshKey,
  onOpenRouting,
}: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CareerSnapshot | null>(null);
  const [routing, setRouting] = useState<RoutingSnapshot | null>(null);
  const [difficulty, setDifficulty] = useState("");
  const [model, setModel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filters, setFilters] = useState<CareerFilters>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const token = ++generation.current;
    const query = new URLSearchParams();
    if (filters.difficulty) query.set("difficulty", filters.difficulty);
    if (filters.model) query.set("model", filters.model);
    if (filters.from !== undefined) query.set("from", String(filters.from));
    if (filters.to !== undefined) query.set("to", String(filters.to));
    setLoading(true);
    setError("");
    try {
      const [peopleData, routingData] = await Promise.all([
        request<CareerSnapshot>(`/api/crew/people${query.size ? `?${query}` : ""}`),
        request<RoutingSnapshot>("/api/crew/routing"),
      ]);
      if (generation.current === token) {
        setSnapshot(peopleData);
        setRouting(routingData);
      }
    } catch (cause) {
      if (generation.current === token) {
        setError(cause instanceof Error ? cause.message : "Teamdaten konnten nicht geladen werden.");
      }
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, [filters]);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    // Keep mounted owner forms during live refreshes. The configuration revision
    // key below resets drafts only when the persisted configuration changes.
    void load();
    return invalidate;
  }, [load, refreshKey, invalidate]);
  const mutate = async (url: string, body: unknown, method: string, message: string) => {
    if (!canManage || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(url, { method, body: JSON.stringify(body) });
      setNotice(message);
      await load();
    } catch (cause) {
      setError(
        isApiRequestError(cause) && cause.status === 409
          ? "Zwischenzeitlich geändert. Bitte erneut laden und die Auswahl prüfen."
          : cause instanceof Error
            ? cause.message
            : "Änderung konnte nicht gespeichert werden.",
      );
    } finally {
      setBusy(false);
    }
  };
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.displayName ?? id;
  return (
    <section className="people-panel" aria-label="Team und Leistung" aria-busy={loading || busy}>
      <header>
        <h2>Team &amp; Leistung</h2>
        <p>Verantwortung zuweisen. Ergebnisse mit nachvollziehbaren Lead-Urteilen beurteilen.</p>
        <p className="people-help">
          Sterne sind Reviewer-Urteile im jeweiligen Aufgaben- und Modellkontext. Durchschnitt und Anzahl sind keine
          objektive Modellgüte; die aktuelle Bewertung je Aufgabe zählt einmal.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Teamdaten werden geladen …</p>}
      {!loading && !snapshot && (
        <button className="ic-btn" onClick={() => void load()}>
          Erneut laden
        </button>
      )}
      <section className="people-section">
        <h3>Bewertungen filtern</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const start = from ? new Date(from).getTime() : undefined;
            const end = to ? new Date(to).getTime() : undefined;
            if (start !== undefined && end !== undefined && start > end) {
              setError("Der Beginn muss vor dem Ende des Zeitraums liegen.");
              return;
            }
            setFilters({
              ...(difficulty ? { difficulty: difficulty as CareerFilters["difficulty"] } : {}),
              ...(model.trim() ? { model: model.trim() } : {}),
              ...(start !== undefined ? { from: start } : {}),
              ...(end !== undefined ? { to: end } : {}),
            });
          }}
        >
          <div className="people-fields">
            <label>
              Schwierigkeit
              <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
                <option value="">Alle Schwierigkeiten</option>
                {Object.entries(DIFFICULTIES).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Modellname (exakt)
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Modell des Arbeits-Runs"
              />
            </label>
            <label>
              Von (lokale Zeit)
              <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              Bis (lokale Zeit)
              <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
          <button type="submit" className="ic-btn" disabled={busy}>
            Filter anwenden
          </button>
        </form>
      </section>
      {snapshot && (
        <>
          <section className="people-section">
            <h3>Mitarbeiter &amp; Modellprofile</h3>
            {!agents.length ? (
              <p>Noch keine Mitarbeiter vorhanden.</p>
            ) : (
              <div className="people-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Mitarbeiter / Fachrolle</th>
                      <th scope="col">Level</th>
                      <th scope="col">Routingprofil</th>
                      <th scope="col">Bewertung</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => {
                      const profile = snapshot.profiles.find((row) => row.agentId === agent.id);
                      const binding = routing?.bindings.find((row) => row.agentId === agent.id);
                      const route = routing?.config.profiles.find((row) => row.key === binding?.profileKey);
                      const rating = snapshot.aggregates.agents.find((row) => row.key === agent.id);
                      return (
                        <tr key={agent.id} data-testid={`people-agent-${agent.id}`}>
                          <th scope="row">
                            {agent.displayName}
                            <p className="people-help">{roleName(agent.professionalRole)}</p>
                          </th>
                          <td>{profile ? LEVELS[profile.level] : "–"}</td>
                          <td>
                            {route
                              ? `${route.label} (${route.key})`
                              : (binding?.profileKey ?? "Keine explizite Bindung")}
                          </td>
                          <td>
                            {rating?.count
                              ? `${average(rating.mean)} / 5 · ${rating.count} Bewertungen`
                              : "– Unbewertet"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {onOpenRouting && (
              <button type="button" className="ic-btn" onClick={onOpenRouting}>
                Bestehende Modellprofile und Zuordnungen öffnen
              </button>
            )}
            <p className="people-help">
              Die neun vorhandenen Routingprofile steuern Runtime, Modell und erlaubte Fallbacks. Eine Leveländerung
              erfindet keine zweite Modellkonfiguration.
            </p>
          </section>
          <section className="people-section">
            <h3>Abteilungszuständigkeit</h3>
            <p>Lead-Delegation: {snapshot.config.enabled ? "aktiv" : "inaktiv"}</p>
            {departments.map((department) => {
              const policy = snapshot.config.departments.find((row) => row.departmentId === department.id);
              return (
                <p key={department.id}>
                  <strong>{department.name}</strong> · {policy?.enabled ? "aktiv" : "inaktiv"} · Lead:{" "}
                  {policy?.leadAgentId ? agentName(policy.leadAgentId) : "–"} · Ersatzreviewer:{" "}
                  {policy?.fallbackReviewerAgentId ? agentName(policy.fallbackReviewerAgentId) : "–"}
                </p>
              );
            })}
          </section>
          {canManage ? (
            <>
              <DepartmentSetup
                key={`config-${snapshot.config.revision}`}
                snapshot={snapshot}
                agents={agents}
                departments={departments}
                busy={busy}
                save={(body) => void mutate("/api/crew/people/config", body, "PUT", "Abteilungssteuerung gespeichert.")}
              />
              <LevelSetup
                snapshot={snapshot}
                agents={agents}
                busy={busy}
                save={(id, body) =>
                  void mutate(
                    `/api/crew/people/agents/${encodeURIComponent(id)}/level`,
                    body,
                    "POST",
                    "Leveländerung zur Freigabe angefragt. Die Entscheidung erfolgt in den Freigaben.",
                  )
                }
              />
            </>
          ) : (
            <p className="people-help">
              Nur der Owner kann Abteilungssteuerung und Mitarbeiterlevel ändern. Lead-Delegation:{" "}
              {snapshot.config.enabled ? "aktiv" : "inaktiv"}.
            </p>
          )}
          {!!snapshot.pendingChanges.length && (
            <section className="people-section">
              <h3>Leveländerungen</h3>
              {snapshot.pendingChanges.map((change) => (
                <p key={change.id}>
                  {agentName(change.agentId)} → {LEVELS[change.level]} · {change.status} · Freigabe{" "}
                  <code>{change.approvalId}</code>
                </p>
              ))}
            </section>
          )}
          <section className="people-section">
            <h3>Delegation &amp; offene Reviews</h3>
            {!snapshot.workflows.some((workflow) => workflow.status !== "completed") ? (
              <p className="people-help">Keine offenen Delegations- oder Review-Schritte.</p>
            ) : (
              snapshot.workflows
                .filter((workflow) => workflow.status !== "completed")
                .map((workflow) => (
                  <article key={workflow.id}>
                    <h4>
                      {workflow.purpose === "routing" ? "Aufgabenverteilung" : "Lead-Review"} ·{" "}
                      {
                        {
                          pending: "Ausstehend",
                          failed: "Fehlgeschlagen",
                          owner_required: "Ownerentscheidung erforderlich",
                          completed: "Abgeschlossen",
                        }[workflow.status]
                      }
                    </h4>
                    <p>
                      Aufgabe <code>{workflow.taskId}</code> · {DIFFICULTIES[workflow.difficulty]}
                    </p>
                    <p>{workflow.rationale || "– Noch keine Begründung verfügbar."}</p>
                    {workflow.runId && (
                      <p>
                        Run <code>{workflow.runId}</code>
                      </p>
                    )}
                    {workflow.reviewerAgentId && <p>Reviewer: {agentName(workflow.reviewerAgentId)}</p>}
                    {workflow.purpose === "review" && (
                      <p className="people-help">– Noch keine abgeschlossene Bewertung für diesen Schritt.</p>
                    )}
                  </article>
                ))
            )}
          </section>
          <RatingsTable title="Bewertungen je Mitarbeiter" rows={snapshot.aggregates.agents} label={agentName} />
          <RatingsTable title="Bewertungen je Modell" rows={snapshot.aggregates.models} label={(key) => key} />
          <ReviewHistory reviews={snapshot.reviews} agentName={agentName} />
        </>
      )}
    </section>
  );
}

/** Profile drilldown reads canonical career/routing data, never persona or local ratings. */
export function PeopleAgentSummary({
  agentId,
  agents,
  refreshKey,
  onOpenPeople,
}: {
  agentId: string;
  agents: Person[];
  refreshKey?: number;
  onOpenPeople: () => void;
}): React.JSX.Element {
  const [data, setData] = useState<{ people: CareerSnapshot; routing: RoutingSnapshot } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null);
    setError("");
    void Promise.all([request<CareerSnapshot>("/api/crew/people"), request<RoutingSnapshot>("/api/crew/routing")])
      .then(([people, routing]) => {
        if (current) setData({ people, routing });
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : "Leistungsdaten konnten nicht geladen werden.");
      });
    return () => {
      current = false;
    };
  }, [agentId, refreshKey, attempt]);
  const profile = data?.people.profiles.find((row) => row.agentId === agentId);
  const rating = data?.people.aggregates.agents.find((row) => row.key === agentId);
  const binding = data?.routing.bindings.find((row) => row.agentId === agentId);
  const route = data?.routing.config.profiles.find((row) => row.key === binding?.profileKey);
  return (
    <section className="people-panel people-section" aria-label="Laufbahn und Aufgabenleistung">
      <h3>Laufbahn &amp; Aufgabenleistung</h3>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="ic-btn" onClick={() => setAttempt((value) => value + 1)}>
            Leistungsdaten erneut laden
          </button>
        </>
      ) : !data ? (
        <p role="status">Leistungsdaten werden geladen …</p>
      ) : (
        <>
          <dl className="people-review-meta">
            <div>
              <dt>Laufbahnstufe</dt>
              <dd>{profile ? LEVELS[profile.level] : "– Nicht eingerichtet"}</dd>
            </div>
            <div>
              <dt>Lead-Bewertungen</dt>
              <dd className="people-average">
                {rating?.count ? `${average(rating.mean)} / 5 · ${rating.count} Bewertungen` : "– Unbewertet"}
              </dd>
            </div>
            <div>
              <dt>Modellprofil</dt>
              <dd>{route ? `${route.label} (${route.key})` : (binding?.profileKey ?? "Keine explizite Bindung")}</dd>
            </div>
          </dl>
          <p className="people-help">
            Reviewer-Urteile zu konkreten Aufgaben. Fachrolle und Berechtigungen sind vom Level getrennt.
          </p>
          <details>
            <summary>Letzte Aufgabenbewertungen</summary>
            <ReviewHistory
              reviews={data.people.reviews.filter((review) => review.agentId === agentId).slice(0, 5)}
              agentName={(id) => agents.find((agent) => agent.id === id)?.displayName ?? id}
            />
          </details>
        </>
      )}
      <button className="ic-btn" onClick={onOpenPeople}>
        Teamsteuerung und gesamten Bewertungsverlauf öffnen
      </button>
    </section>
  );
}
