import { useEffect, useState } from "react";
import { list, string as str, type Row } from "./api.ts";
import styles from "./App.module.css";
export default function Coordination({ order, crew, locale }: { order: Row; crew: Row[]; locale: "de" | "en" }) {
  const [items, setItems] = useState<Row[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void list(`/orders/${str(order, "id")}/coordination`)
        .then((rows) => {
          if (!disposed) {
            setItems(rows);
            setError("");
          }
        })
        .catch((e: Error) => {
          if (!disposed) setError(e.message);
        });
    refresh();
    const timer = order.status === "running" ? setInterval(refresh, 3000) : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [order.id, order.status, order.revision]);
  const activeId = (order.activeCoordination as Row | undefined)?.id;
  return (
    <details className={styles.panel}>
      <summary>
        {locale === "de" ? "Teamabstimmungen" : "Team consultations"} ({items.length})
      </summary>
      {error && <p role="alert">{error}</p>}
      {!items.length && (
        <p>
          {locale === "de"
            ? "Noch keine Abstimmung ausgeführt. Die Crew kann innerhalb ihres Mandats gezielt weitere Mitglieder konsultieren."
            : "No consultation has run yet. The crew can consult other members within its mandate."}
        </p>
      )}
      {items.map((item) => (
        <article key={str(item, "id")}>
          <h3>{str(item, "topic")}</h3>
          <p>
            {item.status === "complete"
              ? locale === "de"
                ? "Beiträge liegen vor"
                : "Contributions available"
              : item.status === "running" && item.id === activeId
                ? locale === "de"
                  ? "Abstimmung läuft"
                  : "Consultation running"
                : locale === "de"
                  ? "Unvollständig – Ausführung und Kosten prüfen"
                  : "Incomplete — reconcile execution and costs"}
          </p>
          {((item.contributions ?? []) as Row[]).map((contribution) => (
            <section key={str(contribution, "turnId")}>
              <h4>
                {str(
                  crew.find((employee) => employee.id === contribution.employeeId) ?? {},
                  "displayName",
                  str(contribution, "employeeId"),
                )}
              </h4>
              <p style={{ whiteSpace: "pre-wrap" }}>{str(contribution, "content")}</p>
            </section>
          ))}
        </article>
      ))}
    </details>
  );
}
