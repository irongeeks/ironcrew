import { useGovernanceI18n } from "./governance-i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson as request } from "./panel-api";
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
  const { tx } = useGovernanceI18n();
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
        <p>{tx(empty)}</p>
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
  const { tx, locale } = useGovernanceI18n();
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
        setError(cause instanceof Error ? cause.message : tx("Projektpläne konnten nicht geladen werden."));
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }, [tx]);
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
          ? tx("Plan freigegeben. Die genehmigten Aufgaben und Abhängigkeiten wurden angelegt.")
          : tx("Plan abgelehnt. Die geplanten Teilaufgaben werden nicht ausgeführt."),
      );
      await load();
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tx("Die Entscheidung konnte nicht gespeichert werden."));
    } finally {
      setPending(null);
    }
  };
  return (
    <section className="project-planning" aria-label={tx("Projektplanung")} aria-busy={loading || pending !== null}>
      <header>
        <h2>{tx("Projektpläne")}</h2>
        <p>
          {tx("Ziel, Umfang und Aufgaben prüfen. Die Crew beginnt die geplante Projektarbeit nach deiner Freigabe.")}
        </p>
      </header>
      {loading && <p role="status">{tx("Projektpläne werden geladen …")}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button className="ic-btn" type="button" disabled={loading || pending !== null} onClick={() => void load()}>
        {tx("Pläne aktualisieren")}{" "}
      </button>
      {!loading && !error && plans.length === 0 && (
        <p>
          {tx(
            "Noch keine Projektpläne. Beschreibe im CEO-Chat ein Projekt; der Executive Assistant erstellt zuerst einen Plan zur Prüfung.",
          )}{" "}
        </p>
      )}
      {plans.map((record) => (
        <article key={record.id} className="project-plan" data-status={record.status}>
          <header>
            <h3>{record.plan?.goal ?? tx("Projekt wird vorbereitet")}</h3>
            <p className="project-plan-status">
              {tx(STATUS[record.status])} · {new Date(record.updated_at).toLocaleString(locale)}
            </p>
          </header>
          <details className="project-plan-source">
            <summary>{tx("Quelle und Verlauf")}</summary>
            <p>
              {tx("Projekt:")} {record.project_id}
            </p>
            <p>
              {tx("Planungsaufgabe:")} {record.task_id}
            </p>
            {record.run_id && (
              <p>
                {tx("Planungs-Run:")} {record.run_id}
              </p>
            )}
            {record.reviewed_by && (
              <p>
                {tx("Entschieden von:")} {record.reviewed_by}
              </p>
            )}
            {onTaskOpen && (
              <button className="ic-btn" type="button" onClick={() => onTaskOpen(record.task_id)}>
                {tx("Planungsaufgabe öffnen")}{" "}
              </button>
            )}
          </details>
          {record.status === "planning" && (
            <p>
              {tx("Der Planungs-Run darf den Auftrag strukturieren. Noch keine geplanten Teilaufgaben freigegeben.")}
            </p>
          )}
          {record.error && <p className="project-plan-error">{record.error}</p>}
          {record.plan && (
            <>
              <div className="project-plan-columns">
                <Items title={tx("Umfang")} items={record.plan.scope} />
                <Items title={tx("Nicht-Ziele")} items={record.plan.nonGoals} />
                <Items title={tx("Annahmen")} items={record.plan.assumptions} />
                <Items title={tx("Risiken")} items={record.plan.risks} />
              </div>
              <section className="project-plan-section">
                <h4>{tx("Geplantes Budget")}</h4>
                <p>
                  {record.plan.budgetMicros > 0
                    ? new Intl.NumberFormat(locale, {
                        style: "currency",
                        currency: "USD",
                        maximumFractionDigits: 6,
                      }).format(record.plan.budgetMicros / 1_000_000)
                    : tx("0 USD angegeben – Annahmen und Freigabepunkte prüfen; kein Nachweis kostenloser Ausführung.")}
                </p>
                <p className="project-plan-help">
                  {tx(
                    "Planwert, keine bereits angefallenen Kosten. Firmen-, Projekt- und Runtime-Limits gelten weiterhin.",
                  )}{" "}
                </p>
              </section>
              <Items title={tx("Erwartete Ergebnisse")} items={record.plan.deliverables} />
              <Items
                title={tx("Freigabepunkte")}
                items={record.plan.approvalPoints}
                empty={tx("Keine zusätzlichen Freigabepunkte angegeben. Die Sicherheitsrichtlinien gelten weiterhin.")}
              />
              <section className="project-plan-section">
                <h4>{tx("Aufgaben und Abhängigkeiten")}</h4>
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
                          <dt>{tx("Aufgabenschlüssel")}</dt>
                          <dd>{task.key}</dd>
                        </div>
                        <div>
                          <dt>{tx("Abhängig von")}</dt>
                          <dd>{task.dependsOn.join(", ") || tx("Keine Abhängigkeit")}</dd>
                        </div>
                        <div>
                          <dt>{tx("Risiko")}</dt>
                          <dd>{tx(RISK[task.riskLevel])}</dd>
                        </div>
                      </dl>
                      <h6>{tx("Abnahmekriterien")}</h6>
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
                    {tx(
                      "Die Freigabe übernimmt diesen Plan in den Task-Baum. Risikoreiche Einzelaktionen benötigen weiterhin ihre eigenen Freigaben.",
                    )}{" "}
                  </p>
                  {canReview ? (
                    <div>
                      <button
                        className="ic-btn"
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void review(record, "approved")}
                      >
                        {tx("Plan freigeben")}{" "}
                      </button>
                      <button
                        className="ic-btn"
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void review(record, "rejected")}
                      >
                        {tx("Plan ablehnen")}{" "}
                      </button>
                    </div>
                  ) : (
                    <p>{tx("Die Entscheidung benötigt die Owner-Rolle.")}</p>
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
