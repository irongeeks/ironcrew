import { useI18n } from "../i18n";
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
const FALLBACK_REVIEW_ROLES = new Set<string>(CAREER_FALLBACK_REVIEWER_ROLES);
function usePeopleLabels() {
  const { t, locale } = useI18n();
  const LEVELS = { junior: "Junior", senior: "Senior", lead: "Lead" } as const;
  const DIFFICULTIES = {
    simple: t({ de: "Einfach", en: "Simple" }),
    normal: "Normal",
    complex: t({ de: "Komplex", en: "Complex" }),
  } as const;
  const PROFESSIONAL_ROLE_NAMES: Record<string, string> = {
    executive_assistant: t({ de: "Executive Assistant", en: "Executive Assistant" }),
    chief_operating_officer: t({ de: "Betriebsleitung · COO", en: "Operations · COO" }),
    chief_technology_officer: t({ de: "Technische Leitung · CTO", en: "Technology · CTO" }),
    head_of_infrastructure: t({ de: "Infrastrukturleitung", en: "Infrastructure lead" }),
    chief_information_security_officer: t({ de: "Informationssicherheit · CISO", en: "Information security · CISO" }),
    finance_and_bookkeeping_lead: t({ de: "Finanzen & Buchhaltung", en: "Finance & bookkeeping" }),
    legal_and_contracts: t({ de: "Recht & Verträge", en: "Legal & contracts" }),
    research_and_intelligence: t({ de: "Recherche & Analyse", en: "Research & analysis" }),
    qa_root_cause_red_team: t({
      de: "Qualitätssicherung & Fehleranalyse",
      en: "Quality assurance & root cause analysis",
    }),
    quality_assurance: t({ de: "Qualitätssicherung", en: "Quality assurance" }),
    ui_ux_and_brand: t({ de: "Design & Marke", en: "Design & brand" }),
    marketing_and_messaging: t({ de: "Marketing & Kommunikation", en: "Marketing & communications" }),
    sales_and_negotiation: t({ de: "Vertrieb & Verhandlung", en: "Sales & negotiation" }),
    knowledge_and_documentation: t({ de: "Wissen & Dokumentation", en: "Knowledge & documentation" }),
    automation_and_tools: t({ de: "Automatisierung & Werkzeuge", en: "Automation & tools" }),
  };
  const roleName = (role: string | undefined) =>
    role
      ? Object.hasOwn(PROFESSIONAL_ROLE_NAMES, role)
        ? PROFESSIONAL_ROLE_NAMES[role]
        : role.replaceAll("_", " ")
      : "";

  const displayTime = (value: number) => new Date(value).toLocaleString(locale);
  const average = (value: number | null) =>
    value === null ? "–" : value.toLocaleString(locale, { maximumFractionDigits: 2 });

  return { LEVELS, DIFFICULTIES, roleName, displayTime, average };
}

function Distribution({ value }: { value: RatingAggregate }) {
  const { t } = useI18n();
  return (
    <dl
      className="people-distribution"
      aria-label={t({ de: "Verteilung von 1 bis 5 Sternen", en: "Distribution from 1 to 5 stars" })}
    >
      {([1, 2, 3, 4, 5] as const).map((score) => (
        <div key={score}>
          <dt>{score}</dt>
          <dd>
            <meter
              aria-label={t({ de: `${score} Sterne`, en: `${score} stars` })}
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
  const { t } = useI18n();
  const { DIFFICULTIES, average } = usePeopleLabels();
  return (
    <section className="people-section">
      <h3>{title}</h3>
      {!rows.length ? (
        <p className="people-help">
          {t({ de: "– Noch keine Bewertungen für diese Auswahl.", en: "– No ratings for this selection yet." })}
        </p>
      ) : (
        <div className="people-table-scroll">
          <table>
            <caption className="ic-sr-only">
              {title}
              {t({
                de: ": aktuelle Bewertungen, keine mehrfach gezählten Revisionen",
                en: ": current ratings, without counting revisions twice",
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">{t({ de: "Ø Sterne", en: "Average stars" })}</th>
                <th scope="col">{t({ de: "Anzahl", en: "Count" })}</th>
                <th scope="col">{t({ de: "Verteilung 1–5", en: "Distribution 1–5" })}</th>
                <th scope="col">{t({ de: "Schwierigkeit", en: "Difficulty" })}</th>
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
  const { t } = useI18n();
  const { DIFFICULTIES, displayTime } = usePeopleLabels();
  return (
    <section className="people-section">
      <h3>{t({ de: "Aufgabenbewertungen & Revisionen", en: "Task ratings & revisions" })}</h3>
      {!reviews.length && (
        <p className="people-help">
          {t({
            de: "Noch keine Bewertungen. Ein abgeschlossener Arbeits-Run und ein unabhängiger Lead-Review sind erforderlich.",
            en: "No ratings yet. A completed work run and an independent lead review are required.",
          })}{" "}
        </p>
      )}
      <div className="people-history">
        {reviews.map((review) => (
          <article key={review.id}>
            <h4>
              {agentName(review.agentId)} ·{" "}
              <span className="people-average">
                {review.score} {t({ de: "/ 5 Sterne", en: "/ 5 stars" })}
              </span>
            </h4>
            <p className="people-help">
              {DIFFICULTIES[review.difficulty]} · Revision {review.revision} ·{" "}
              {review.isCurrent
                ? t({ de: "Aktuelle Bewertung", en: "Current rating" })
                : t({ de: "Historisch – nicht im Durchschnitt", en: "Historical – excluded from the average" })}
            </p>
            <pre>{review.rationale}</pre>
            <dl className="people-review-meta">
              <div>
                <dt>Reviewer</dt>
                <dd>{agentName(review.reviewerAgentId)}</dd>
              </div>
              <div>
                <dt>{t({ de: "Zeitpunkt", en: "Time" })}</dt>
                <dd>{displayTime(review.createdAt)}</dd>
              </div>
              <div>
                <dt>{t({ de: "Modell des Arbeits-Runs", en: "Work run model" })}</dt>
                <dd>
                  {review.model ?? t({ de: "Modell nicht erfasst", en: "Model not recorded" })} · {review.runtimeType}
                </dd>
              </div>
              <div>
                <dt>{t({ de: "Aufgabe", en: "Task" })}</dt>
                <dd>
                  <code>{review.taskId}</code>
                </dd>
              </div>
            </dl>
            <details>
              <summary>{t({ de: "Run-Nachweise und Bewertungsrubrik", en: "Run evidence and review rubric" })}</summary>
              <p>
                {t({ de: "Rubrik-Version", en: "Rubric version" })} {review.rubricVersion}{" "}
                {t({ de: "· Reviewer-Modell:", en: "· Reviewer model:" })}{" "}
                {review.reviewerModel ?? t({ de: "nicht erfasst", en: "not recorded" })} · {review.reviewerRuntimeType}
              </p>
              <p>
                {t({ de: "Reviewer-Vessel:", en: "Reviewer vessel:" })} {review.reviewerVesselId ?? "–"}
              </p>
              <dl className="people-review-meta">
                <div>
                  <dt>{t({ de: "Arbeits-Run", en: "Work run" })}</dt>
                  <dd>
                    <code>{review.workRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t({ de: "Review-Run", en: "Review run" })}</dt>
                  <dd>
                    <code>{review.reviewRunId}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t({ de: "Vessel des Arbeits-Runs", en: "Work run vessel" })}</dt>
                  <dd>{review.vesselId || "–"}</dd>
                </div>
              </dl>
              <p>
                {t({ de: "Richtigkeit:", en: "Correctness:" })} {review.rubricDimensions.correctness}
                {t({ de: "/5 · Vollständigkeit:", en: "/5 · Completeness:" })} {review.rubricDimensions.completeness}
                {t({ de: "/5 · Qualität:", en: "/5 · Quality:" })} {review.rubricDimensions.quality}/5
              </p>
              {review.evidence.length ? (
                <ul>
                  {review.evidence.map((entry, index) => (
                    <li key={index}>{entry}</li>
                  ))}
                </ul>
              ) : (
                <p>{t({ de: "Keine zusätzlichen Nachweise angegeben.", en: "No additional evidence provided." })}</p>
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
  const { t } = useI18n();
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
        <legend>{t({ de: "Abteilungsleitung & Delegation", en: "Department leads & delegation" })}</legend>
        <label className="people-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {t({
            de: "Lead-Delegation und Aufgabenbewertung aktivieren",
            en: "Enable lead delegation and task reviews",
          })}{" "}
        </label>
        <p className="people-help">
          {t({
            de: "Der Lead verteilt Aufgaben nach Schwierigkeit. Bewertungen benötigen einen unabhängigen Reviewer; keine Selbstbewertung. Eigene Lead-Arbeit prüft ein unabhängiger QA-/COO-Reviewer. Level und fachliche Rolle bleiben getrennt.",
            en: "The lead assigns tasks by difficulty. Reviews require an independent reviewer; self-review is not allowed. An independent QA/COO reviewer assesses the lead’s own work. Career level and professional role remain separate.",
          })}{" "}
        </p>
        <p className="people-help">
          {t({
            de: "Für eine neue Abteilungsleitung zuerst die Laufbahnstufe Lead anfragen und in den Freigaben bestätigen; anschließend hier zuweisen.",
            en: "To appoint a new department lead, first request the Lead career level and approve it in Approvals, then assign the lead here.",
          })}{" "}
        </p>
        {!departments.length && <p>{t({ de: "Noch keine Abteilungen vorhanden.", en: "No departments yet." })}</p>}
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
              {t({ de: "Delegation für diese Abteilung", en: "Delegation for this department" })}{" "}
            </label>
            <div className="people-fields">
              <label>
                {t({ de: "Abteilungslead", en: "Department lead" })}{" "}
                <select
                  value={row.leadAgentId ?? ""}
                  onChange={(event) => patch(row.departmentId, { leadAgentId: event.target.value || null })}
                >
                  <option value="">{t({ de: "Nicht zugewiesen", en: "Not assigned" })}</option>
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
                {t({ de: "Unabhängiger Ersatzreviewer", en: "Independent fallback reviewer" })}{" "}
                <select
                  value={row.fallbackReviewerAgentId ?? ""}
                  onChange={(event) => patch(row.departmentId, { fallbackReviewerAgentId: event.target.value || null })}
                >
                  <option value="">{t({ de: "Nicht zugewiesen", en: "Not assigned" })}</option>
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
          {t({ de: "Abteilungssteuerung speichern", en: "Save department settings" })}{" "}
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
  const { t } = useI18n();
  const { LEVELS } = usePeopleLabels();
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
        <legend>{t({ de: "Mitarbeiterlevel ändern", en: "Change employee level" })}</legend>
        <div className="people-fields">
          <label>
            {t({ de: "Mitarbeiter", en: "Employee" })}{" "}
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
            {t({ de: "Neues Level", en: "New level" })}{" "}
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
          {t({ de: "Aktuell:", en: "Current:" })} {profile ? LEVELS[profile.level] : "–"}
          {t({
            de: ". Die Änderung wird als Freigabe angefragt. Rollen, Tools und Modellkonfiguration werden dadurch nicht ersetzt.",
            en: ". The change is submitted for approval. It does not replace roles, tools or model configuration.",
          })}{" "}
        </p>
        <label>
          {t({ de: "Begründung", en: "Reason" })}{" "}
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
          {t({ de: "Leveländerung zur Freigabe anfragen", en: "Request approval for level change" })}{" "}
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
  const { t } = useI18n();
  const { LEVELS, DIFFICULTIES, roleName, average } = usePeopleLabels();
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
        setError(
          cause instanceof Error
            ? cause.message
            : t({ de: "Teamdaten konnten nicht geladen werden.", en: "Could not load team data." }),
        );
      }
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, [filters, t]);
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
          ? t({
              de: "Zwischenzeitlich geändert. Bitte erneut laden und die Auswahl prüfen.",
              en: "Changed in the meantime. Reload and check your selection.",
            })
          : cause instanceof Error
            ? cause.message
            : t({ de: "Änderung konnte nicht gespeichert werden.", en: "Could not save the change." }),
      );
    } finally {
      setBusy(false);
    }
  };
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.displayName ?? id;
  return (
    <section
      className="people-panel"
      aria-label={t({ de: "Team und Leistung", en: "Team and performance" })}
      aria-busy={loading || busy}
    >
      <header>
        <h2>{t({ de: "Team & Leistung", en: "Team & performance" })}</h2>
        <p>
          {t({
            de: "Verantwortung zuweisen. Ergebnisse mit nachvollziehbaren Lead-Urteilen beurteilen.",
            en: "Assign responsibility. Assess results using traceable lead reviews.",
          })}
        </p>
        <p className="people-help">
          {t({
            de: "Sterne sind Reviewer-Urteile im jeweiligen Aufgaben- und Modellkontext. Durchschnitt und Anzahl sind keine objektive Modellgüte; die aktuelle Bewertung je Aufgabe zählt einmal.",
            en: "Stars reflect reviewer judgments for a specific task and model. Averages and counts are not an objective measure of model quality; each task’s current rating is counted once.",
          })}{" "}
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">{t({ de: "Teamdaten werden geladen …", en: "Loading team data …" })}</p>}
      {!loading && !snapshot && (
        <button className="ic-btn" onClick={() => void load()}>
          {t({ de: "Erneut laden", en: "Reload" })}{" "}
        </button>
      )}
      <section className="people-section">
        <h3>{t({ de: "Bewertungen filtern", en: "Filter ratings" })}</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const start = from ? new Date(from).getTime() : undefined;
            const end = to ? new Date(to).getTime() : undefined;
            if (start !== undefined && end !== undefined && start > end) {
              setError(
                t({
                  de: "Der Beginn muss vor dem Ende des Zeitraums liegen.",
                  en: "The start must be before the end of the period.",
                }),
              );
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
              {t({ de: "Schwierigkeit", en: "Difficulty" })}{" "}
              <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
                <option value="">{t({ de: "Alle Schwierigkeiten", en: "All difficulties" })}</option>
                {Object.entries(DIFFICULTIES).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t({ de: "Modellname (exakt)", en: "Model name (exact)" })}{" "}
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={t({ de: "Modell des Arbeits-Runs", en: "Work run model" })}
              />
            </label>
            <label>
              {t({ de: "Von (lokale Zeit)", en: "From (local time)" })}{" "}
              <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              {t({ de: "Bis (lokale Zeit)", en: "To (local time)" })}{" "}
              <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
          <button type="submit" className="ic-btn" disabled={busy}>
            {t({ de: "Filter anwenden", en: "Apply filters" })}{" "}
          </button>
        </form>
      </section>
      {snapshot && (
        <>
          <section className="people-section">
            <h3>{t({ de: "Mitarbeiter & Modellprofile", en: "Employees & model profiles" })}</h3>
            {!agents.length ? (
              <p>{t({ de: "Noch keine Mitarbeiter vorhanden.", en: "No employees yet." })}</p>
            ) : (
              <div className="people-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t({ de: "Mitarbeiter / Fachrolle", en: "Employee / professional role" })}</th>
                      <th scope="col">Level</th>
                      <th scope="col">{t({ de: "Routingprofil", en: "Routing profile" })}</th>
                      <th scope="col">{t({ de: "Bewertung", en: "Rating" })}</th>
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
                              : (binding?.profileKey ??
                                t({ de: "Keine explizite Bindung", en: "No explicit binding" }))}
                          </td>
                          <td>
                            {rating?.count
                              ? t({
                                  de: `${average(rating.mean)} / 5 · ${rating.count} Bewertungen`,
                                  en: `${average(rating.mean)} / 5 · ${rating.count} ratings`,
                                })
                              : t({ de: "– Unbewertet", en: "– Unrated" })}
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
                {t({
                  de: "Bestehende Modellprofile und Zuordnungen öffnen",
                  en: "Open existing model profiles and assignments",
                })}{" "}
              </button>
            )}
            <p className="people-help">
              {t({
                de: "Die neun vorhandenen Routingprofile steuern Runtime, Modell und erlaubte Fallbacks. Eine Leveländerung erfindet keine zweite Modellkonfiguration.",
                en: "The nine existing routing profiles control runtime, model and allowed fallbacks. A level change does not create a second model configuration.",
              })}{" "}
            </p>
          </section>
          <section className="people-section">
            <h3>{t({ de: "Abteilungszuständigkeit", en: "Department responsibility" })}</h3>
            <p>
              {t({ de: "Lead-Delegation:", en: "Lead delegation:" })}{" "}
              {snapshot.config.enabled ? t({ de: "aktiv", en: "active" }) : t({ de: "inaktiv", en: "inactive" })}
            </p>
            {departments.map((department) => {
              const policy = snapshot.config.departments.find((row) => row.departmentId === department.id);
              return (
                <p key={department.id}>
                  <strong>{department.name}</strong> ·{" "}
                  {policy?.enabled ? t({ de: "aktiv", en: "active" }) : t({ de: "inaktiv", en: "inactive" })} · Lead:{" "}
                  {policy?.leadAgentId ? agentName(policy.leadAgentId) : "–"}{" "}
                  {t({ de: "· Ersatzreviewer:", en: "· Fallback reviewer:" })}{" "}
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
                save={(body) =>
                  void mutate(
                    "/api/crew/people/config",
                    body,
                    "PUT",
                    t({ de: "Abteilungssteuerung gespeichert.", en: "Department settings saved." }),
                  )
                }
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
                    t({
                      de: "Leveländerung zur Freigabe angefragt. Die Entscheidung erfolgt in den Freigaben.",
                      en: "Level change submitted for approval. The decision is made in Approvals.",
                    }),
                  )
                }
              />
            </>
          ) : (
            <p className="people-help">
              {t({
                de: "Nur der Owner kann Abteilungssteuerung und Mitarbeiterlevel ändern. Lead-Delegation:",
                en: "Only the owner can change department settings and employee levels. Lead delegation:",
              })}{" "}
              {snapshot.config.enabled ? t({ de: "aktiv", en: "active" }) : t({ de: "inaktiv", en: "inactive" })}.
            </p>
          )}
          {!!snapshot.pendingChanges.length && (
            <section className="people-section">
              <h3>{t({ de: "Leveländerungen", en: "Level changes" })}</h3>
              {snapshot.pendingChanges.map((change) => (
                <p key={change.id}>
                  {agentName(change.agentId)} → {LEVELS[change.level]} ·{" "}
                  {t({
                    de:
                      {
                        pending: "Ausstehend",
                        approved: "Genehmigt",
                        rejected: "Abgelehnt",
                        applied: "Angewendet",
                        failed: "Fehlgeschlagen",
                      }[change.status] ?? change.status,
                    en: change.status,
                  })}{" "}
                  {t({ de: "· Freigabe", en: "· Approval" })} <code>{change.approvalId}</code>
                </p>
              ))}
            </section>
          )}
          <section className="people-section">
            <h3>{t({ de: "Delegation & offene Reviews", en: "Delegation & open reviews" })}</h3>
            {!snapshot.workflows.some((workflow) => workflow.status !== "completed") ? (
              <p className="people-help">
                {t({
                  de: "Keine offenen Delegations- oder Review-Schritte.",
                  en: "No open delegation or review steps.",
                })}
              </p>
            ) : (
              snapshot.workflows
                .filter((workflow) => workflow.status !== "completed")
                .map((workflow) => (
                  <article key={workflow.id}>
                    <h4>
                      {workflow.purpose === "routing"
                        ? t({ de: "Aufgabenverteilung", en: "Task assignment" })
                        : t({ de: "Lead-Review", en: "Lead review" })}{" "}
                      ·{" "}
                      {
                        {
                          pending: t({ de: "Ausstehend", en: "Pending" }),
                          failed: t({ de: "Fehlgeschlagen", en: "Failed" }),
                          owner_required: t({ de: "Ownerentscheidung erforderlich", en: "Owner decision required" }),
                          completed: t({ de: "Abgeschlossen", en: "Completed" }),
                        }[workflow.status]
                      }
                    </h4>
                    <p>
                      {t({ de: "Aufgabe", en: "Task" })} <code>{workflow.taskId}</code> ·{" "}
                      {DIFFICULTIES[workflow.difficulty]}
                    </p>
                    <p>
                      {workflow.rationale ||
                        t({ de: "– Noch keine Begründung verfügbar.", en: "– No reason available yet." })}
                    </p>
                    {workflow.runId && (
                      <p>
                        Run <code>{workflow.runId}</code>
                      </p>
                    )}
                    {workflow.reviewerAgentId && <p>Reviewer: {agentName(workflow.reviewerAgentId)}</p>}
                    {workflow.purpose === "review" && (
                      <p className="people-help">
                        {t({
                          de: "– Noch keine abgeschlossene Bewertung für diesen Schritt.",
                          en: "– No completed review for this step yet.",
                        })}
                      </p>
                    )}
                  </article>
                ))
            )}
          </section>
          <RatingsTable
            title={t({ de: "Bewertungen je Mitarbeiter", en: "Ratings by employee" })}
            rows={snapshot.aggregates.agents}
            label={agentName}
          />
          <RatingsTable
            title={t({ de: "Bewertungen je Modell", en: "Ratings by model" })}
            rows={snapshot.aggregates.models}
            label={(key) => key}
          />
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
  const { t } = useI18n();
  const { LEVELS, average } = usePeopleLabels();
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
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : t({ de: "Leistungsdaten konnten nicht geladen werden.", en: "Could not load performance data." }),
          );
      });
    return () => {
      current = false;
    };
  }, [agentId, refreshKey, attempt, t]);
  const profile = data?.people.profiles.find((row) => row.agentId === agentId);
  const rating = data?.people.aggregates.agents.find((row) => row.key === agentId);
  const binding = data?.routing.bindings.find((row) => row.agentId === agentId);
  const route = data?.routing.config.profiles.find((row) => row.key === binding?.profileKey);
  return (
    <section
      className="people-panel people-section"
      aria-label={t({ de: "Laufbahn und Aufgabenleistung", en: "Career and task performance" })}
    >
      <h3>{t({ de: "Laufbahn & Aufgabenleistung", en: "Career & task performance" })}</h3>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="ic-btn" onClick={() => setAttempt((value) => value + 1)}>
            {t({ de: "Leistungsdaten erneut laden", en: "Reload performance data" })}{" "}
          </button>
        </>
      ) : !data ? (
        <p role="status">{t({ de: "Leistungsdaten werden geladen …", en: "Loading performance data …" })}</p>
      ) : (
        <>
          <dl className="people-review-meta">
            <div>
              <dt>{t({ de: "Laufbahnstufe", en: "Career level" })}</dt>
              <dd>{profile ? LEVELS[profile.level] : t({ de: "– Nicht eingerichtet", en: "– Not configured" })}</dd>
            </div>
            <div>
              <dt>{t({ de: "Lead-Bewertungen", en: "Lead ratings" })}</dt>
              <dd className="people-average">
                {rating?.count
                  ? t({
                      de: `${average(rating.mean)} / 5 · ${rating.count} Bewertungen`,
                      en: `${average(rating.mean)} / 5 · ${rating.count} ratings`,
                    })
                  : t({ de: "– Unbewertet", en: "– Unrated" })}
              </dd>
            </div>
            <div>
              <dt>{t({ de: "Modellprofil", en: "Model profile" })}</dt>
              <dd>
                {route
                  ? `${route.label} (${route.key})`
                  : (binding?.profileKey ?? t({ de: "Keine explizite Bindung", en: "No explicit binding" }))}
              </dd>
            </div>
          </dl>
          <p className="people-help">
            {t({
              de: "Reviewer-Urteile zu konkreten Aufgaben. Fachrolle und Berechtigungen sind vom Level getrennt.",
              en: "Reviewer judgments on specific tasks. Professional role and permissions are separate from career level.",
            })}{" "}
          </p>
          <details>
            <summary>{t({ de: "Letzte Aufgabenbewertungen", en: "Recent task ratings" })}</summary>
            <ReviewHistory
              reviews={data.people.reviews.filter((review) => review.agentId === agentId).slice(0, 5)}
              agentName={(id) => agents.find((agent) => agent.id === id)?.displayName ?? id}
            />
          </details>
        </>
      )}
      <button className="ic-btn" onClick={onOpenPeople}>
        {t({
          de: "Teamsteuerung und gesamten Bewertungsverlauf öffnen",
          en: "Open team settings and full rating history",
        })}{" "}
      </button>
    </section>
  );
}
