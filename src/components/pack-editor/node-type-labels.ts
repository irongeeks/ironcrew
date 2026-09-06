import type { NodeTypeInfoResponse } from "../../api/workflow-packs";

const BUILTIN_KEYS = new Set(["echo", "comfyui_generate", "planning_meeting", "cross_dept"]);
const GERMAN: Record<string, string> = {
  "ComfyUI Generate": "ComfyUI-Generierung",
  "Generate images, videos, or speech audio via a ComfyUI server.":
    "Bilder, Videos oder Sprachausgabe über einen ComfyUI-Server erzeugen.",
  "Planning Meeting": "Planungsbesprechung",
  "Analyze a task brief and produce a structured execution plan with action items and department assignments.":
    "Eine Aufgabenbeschreibung analysieren und einen strukturierten Ausführungsplan mit Maßnahmen und Abteilungszuordnungen erstellen.",
  "Cross-Dept Handoff": "Abteilungsübergreifende Übergabe",
  "Route plan items to target departments and assign team leaders for cross-department collaboration.":
    "Planungspunkte an die zuständigen Abteilungen verteilen und Teamleitungen für die Zusammenarbeit zuweisen.",
  "Passes all inputs through to outputs unchanged. Useful for testing and debugging workflows.":
    "Alle Eingaben unverändert an die Ausgaben weitergeben. Hilfreich zum Testen und zur Fehlersuche in Workflows.",
  Capability: "Fähigkeit",
  "Which ComfyUI capability to invoke (text2img, img2video, or text2speech)":
    "Auszuführende ComfyUI-Fähigkeit (text2img, img2video oder text2speech)",
  "Text → Image": "Text → Bild",
  "Image → Video": "Bild → Video",
  "Text → Speech": "Text → Sprache",
  Width: "Breite",
  Height: "Höhe",
  "Output width in pixels (text2img only, default: workflow default)":
    "Ausgabebreite in Pixeln (nur text2img; Standard: Workflow-Vorgabe)",
  "Output height in pixels (text2img only, default: workflow default)":
    "Ausgabehöhe in Pixeln (nur text2img; Standard: Workflow-Vorgabe)",
  "Random seed for reproducibility (-1 for random)":
    "Zufallsstartwert für reproduzierbare Ergebnisse (-1 für zufällig)",
  "Max Action Items": "Maximale Maßnahmen",
  "Maximum number of action items to extract from planning notes (default: 8)":
    "Maximale Anzahl der Maßnahmen aus den Planungsnotizen (Standard: 8)",
  "Require Approval": "Freigabe erforderlich",
  "When true, the node returns awaiting_approval so the user can review the plan before proceeding":
    "Bei Aktivierung wartet der Knoten auf die Freigabe, damit der Benutzer den Plan vor der Fortsetzung prüfen kann.",
  "Source Department": "Ursprungsabteilung",
  "Department ID of the originating team. Items targeting this department are not treated as cross-dept.":
    "Abteilungs-ID des ursprünglichen Teams. An diese Abteilung gerichtete Punkte gelten nicht als abteilungsübergreifend.",
  "When true, pause after creating handoffs so the user can review assignments before proceeding":
    "Bei Aktivierung nach dem Erstellen der Übergaben pausieren, damit der Benutzer die Zuweisungen vor der Fortsetzung prüfen kann.",
  "Log Label": "Protokollbezeichnung",
  "Optional label that appears in the task log when this node runs (e.g. 'Step 1 complete')":
    "Optionale Bezeichnung im Aufgabenprotokoll bei der Ausführung dieses Knotens (z. B. „Schritt 1 abgeschlossen“)",
  "Input Data": "Eingabedaten",
  "Output Data": "Ausgabedaten",
  "Any data to pass through. If not connected, outputs an empty object.":
    "Beliebige weiterzugebende Daten. Ohne Verbindung wird ein leeres Objekt ausgegeben.",
  "The same data that was received on the input port.": "Dieselben Daten, die am Eingabeanschluss empfangen wurden.",
  "Negative Prompt": "Negativer Prompt",
  "Input Image": "Eingabebild",
  Language: "Sprache",
  Exaggeration: "Ausdrucksstärke",
  "Audio Prompt": "Audiovorlage",
  "Generated Artifacts": "Erzeugte Dateien",
  "Primary Output Path": "Primärer Ausgabepfad",
  "Task Brief": "Aufgabenbeschreibung",
  "Planning Notes": "Planungsnotizen",
  "Department Scope": "Abteilungsumfang",
  "Execution Plan": "Ausführungsplan",
  "Plan Summary": "Planzusammenfassung",
  "Involved Departments": "Beteiligte Abteilungen",
  "Handoff Manifest": "Übergabeverzeichnis",
  "Handoff Summary": "Übergabezusammenfassung",
  "Handoff Count": "Anzahl der Übergaben",
};

/** Translate only known built-in display metadata; keep IDs, configuration and custom nodes intact. */
export function localizeNodeType(node: NodeTypeInfoResponse, language: string): NodeTypeInfoResponse {
  if (language !== "de" || !BUILTIN_KEYS.has(node.key) || node.meta.category === "custom") return node;
  const text = (value: string) => GERMAN[value] ?? value;
  return {
    ...node,
    meta: { ...node.meta, label: text(node.meta.label), description: text(node.meta.description) },
    configSchema: node.configSchema.map((field) => ({
      ...field,
      label: text(field.label),
      description: text(field.description),
      options: field.options?.map((option) => ({ ...option, label: text(option.label) })),
    })),
    inputs: node.inputs.map((port) => ({ ...port, label: text(port.label) })),
    outputs: node.outputs.map((port) => ({ ...port, label: text(port.label) })),
  };
}
