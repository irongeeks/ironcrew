import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "../api/core";
import type { ProjectPlanRecord } from "../shared/project-planning";
import "./ProjectPlanningPanel.css";

const STATUS = {
  planning: "Planung läuft",
  review: "CEO-Entscheidung offen",
  approved: "Plan freigegeben",
  rejected: "Plan abgelehnt",
  failed: "Plan nicht verwendbar",
};
const RISK = { low: "Niedrig", medium: "Mittel", high: "Hoch", critical: "Kritisch" };
interface Props {
  canReview?: boolean;
  onChanged?: () => void | Promise<void>;
  refreshKey?: number;
  onTaskOpen?: (taskId: string) => void;
}
function Items({ title, items, empty = "Keine angegeben." }: { title: string; items: string[]; empty?: string }) {
  return (
    <section className="project-plan-section">
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
export function ProjectPlanningPanel({
  canReview = true,
  onChanged,
  refreshKey,
  onTaskOpen,
}: Props): React.JSX.Element {
  const [plans, setPlans] = useState<ProjectPlanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const seq = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await request<{ plans: ProjectPlanRecord[] }>("/api/crew/project-plans");
      if (seq === generation.current) setPlans(result.plans);
    } catch (cause) {
      if (seq === generation.current)
        setError(cause instanceof Error ? cause.message : "Projektpläne konnten nicht geladen werden.");
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    void load();
    return invalidate;
  }, [load, invalidate, refreshKey]);
  const review = async (record: ProjectPlanRecord, decision: "approved" | "rejected") => {
    setPending(record.id);
    setError("");
    setNotice("");
    try {
      await request(`/api/crew/project-plans/${encodeURIComponent(record.task_id)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setNotice(
        decision === "approved"
          ? "Plan freigegeben. Die genehmigten Aufgaben und Abhängigkeiten wurden angelegt."
          : "Plan abgelehnt. Die geplanten Teilaufgaben werden nicht ausgeführt.",
      );
      await load();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Entscheidung konnte nicht gespeichert werden.");
    } finally {
      setPending(null);
    }
  };
  return (
    <section className="project-planning" aria-label="Projektplanung" aria-busy={loading || pending !== null}>
      <header>
        <h2>Projektpläne</h2>
        <p>Ziel, Umfang und Aufgaben prüfen. Die Crew beginnt die geplante Projektarbeit nach deiner Freigabe.</p>
      </header>
      {loading && <p role="status">Projektpläne werden geladen …</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button className="ic-btn" type="button" disabled={loading || pending !== null} onClick={() => void load()}>
        Pläne aktualisieren
      </button>
      {!loading && !error && plans.length === 0 && (
        <p>
          Noch keine Projektpläne. Beschreibe im CEO-Chat ein Projekt; der Executive Assistant erstellt zuerst einen
          Plan zur Prüfung.
        </p>
      )}
      {plans.map((record) => (
        <article key={record.id} className="project-plan" data-status={record.status}>
          <header>
            <h3>{record.plan?.goal ?? "Projekt wird vorbereitet"}</h3>
            <p className="project-plan-status">
              {STATUS[record.status]} · {new Date(record.updated_at).toLocaleString("de-DE")}
            </p>
          </header>
          <details className="project-plan-source">
            <summary>Quelle und Verlauf</summary>
            <p>Projekt: {record.project_id}</p>
            <p>Planungsaufgabe: {record.task_id}</p>
            {record.run_id && <p>Planungs-Run: {record.run_id}</p>}
            {record.reviewed_by && <p>Entschieden von: {record.reviewed_by}</p>}
            {onTaskOpen && (
              <button className="ic-btn" type="button" onClick={() => onTaskOpen(record.task_id)}>
                Planungsaufgabe öffnen
              </button>
            )}
          </details>
          {record.status === "planning" && (
            <p>Der Planungs-Run darf den Auftrag strukturieren. Noch keine geplanten Teilaufgaben freigegeben.</p>
          )}
          {record.error && <p className="project-plan-error">{record.error}</p>}
          {record.plan && (
            <>
              <div className="project-plan-columns">
                <Items title="Umfang" items={record.plan.scope} />
                <Items title="Nicht-Ziele" items={record.plan.nonGoals} />
                <Items title="Annahmen" items={record.plan.assumptions} />
                <Items title="Risiken" items={record.plan.risks} />
              </div>
              <section className="project-plan-section">
                <h4>Geplantes Budget</h4>
                <p>
                  {record.plan.budgetMicros > 0
                    ? new Intl.NumberFormat("de-DE", {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 6,
                      }).format(record.plan.budgetMicros / 1_000_000)
                    : "0 USD angegeben – Annahmen und Freigabepunkte prüfen; kein Nachweis kostenloser Ausführung."}
                </p>
                <p className="project-plan-help">
                  Planwert, keine bereits angefallenen Kosten. Firmen-, Projekt- und Runtime-Limits gelten weiterhin.
                </p>
              </section>
              <Items title="Erwartete Ergebnisse" items={record.plan.deliverables} />
              <Items
                title="Freigabepunkte"
                items={record.plan.approvalPoints}
                empty="Keine zusätzlichen Freigabepunkte angegeben. Die Sicherheitsrichtlinien gelten weiterhin."
              />
              <section className="project-plan-section">
                <h4>Aufgaben und Abhängigkeiten</h4>
                <ol className="project-plan-tasks">
                  {record.plan.tasks.map((task) => (
                    <li key={task.key}>
                      <h5>{task.title}</h5>
                      <p>{task.description}</p>
                      <dl>
                        <div>
                          <dt>Agent</dt>
                          <dd>{task.agentKey}</dd>
                        </div>
                        <div>
                          <dt>Aufgabenschlüssel</dt>
                          <dd>{task.key}</dd>
                        </div>
                        <div>
                          <dt>Abhängig von</dt>
                          <dd>{task.dependsOn.join(", ") || "Keine Abhängigkeit"}</dd>
                        </div>
                        <div>
                          <dt>Risiko</dt>
                          <dd>{RISK[task.riskLevel]}</dd>
                        </div>
                      </dl>
                      <h6>Abnahmekriterien</h6>
                      <ul>
                        {task.acceptanceCriteria.map((criterion, index) => (
                          <li key={index}>{criterion}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </section>
              {record.status === "review" && (
                <div className="project-plan-review">
                  <p>
                    Die Freigabe übernimmt diesen Plan in den Task-Baum. Risikoreiche Einzelaktionen benötigen weiterhin
                    ihre eigenen Freigaben.
                  </p>
                  {canReview ? (
                    <div>
                      <button
                        className="ic-btn"
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void review(record, "approved")}
                      >
                        Plan freigeben
                      </button>
                      <button
                        className="ic-btn"
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void review(record, "rejected")}
                      >
                        Plan ablehnen
                      </button>
                    </div>
                  ) : (
                    <p>Die Entscheidung benötigt die Owner-Rolle.</p>
                  )}
                </div>
              )}
            </>
          )}
        </article>
      ))}
    </section>
  );
}
