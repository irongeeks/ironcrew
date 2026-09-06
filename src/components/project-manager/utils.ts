import type { ProjectDecisionEventItem } from "../../api";
import type { ProjectI18nTranslate } from "./types";

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function getDecisionEventLabel(
  eventType: ProjectDecisionEventItem["event_type"],
  t: ProjectI18nTranslate,
): string {
  switch (eventType) {
    case "planning_summary":
      return t({ en: "Planning Summary", de: "Planungszusammenfassung" });
    case "representative_pick":
      return t({ en: "Representative Pick", de: "Wesentliche Auswahl" });
    case "followup_request":
      return t({ en: "Follow-up Request", de: "Folgeanfrage" });
    case "start_review_meeting":
      return t({ en: "Review Meeting Started", de: "Überprüfungssitzung gestartet" });
    default:
      return eventType;
  }
}
