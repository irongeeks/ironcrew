import type { LangText } from "../i18n";
import type { View } from "./types";

/** Shared labels keep desktop and mobile navigation consistent. */
export const NAVIGATION_LABELS = {
  command: { en: "Command", de: "Zentrale" },
  office: { en: "Office", de: "Büro" },
  tasks: { en: "Tasks", de: "Aufgaben" },
  workflows: { en: "Workflows", de: "Abläufe" },
  operations: { en: "Operations", de: "Betrieb" },
  agents: { en: "Agents", de: "Agenten" },
  skills: { en: "Library", de: "Bibliothek" },
  projects: { en: "Projects", de: "Projekte" },
  schedules: { en: "Schedules", de: "Zeitpläne" },
  settings: { en: "Settings", de: "Einstellungen" },
} satisfies Partial<Record<View, LangText>>;
