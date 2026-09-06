export type ViewName =
  | "command"
  | "office"
  | "tasks"
  | "workflows"
  | "operations"
  | "agents"
  | "skills"
  | "projects"
  | "schedules"
  | "settings";

// The top bar uppercases rendered labels; other navigation surfaces retain title case.
// Match exact localized names independently of their presentation casing.
export const VIEW_LABELS: Record<ViewName, RegExp> = {
  command: /^(Command|Zentrale)$/i,
  office: /^(Office|Büro)$/i,
  tasks: /^(Tasks|Aufgaben)$/i,
  workflows: /^(Workflows|Abläufe)$/i,
  operations: /^(Operations|Betrieb)$/i,
  agents: /^(Agents|Agenten)$/i,
  skills: /^(Library|Bibliothek)$/i,
  projects: /^(Projects|Projekte)$/i,
  schedules: /^(Schedules|Zeitpläne)$/i,
  settings: /^(Settings|Einstellungen)$/i,
};
