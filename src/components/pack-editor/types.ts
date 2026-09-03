/** Response from GET /api/ops/workflow-packs/:key/definition */
export interface PackDefinitionResponse {
  key: string;
  source: "built-in" | "community";
  definition: {
    pack: {
      key: string;
      name: Record<string, string>;
      version: string;
      schema_version: number;
      description: Record<string, string>;
      icon?: string;
    };
    input: {
      required: PackInputField[];
      optional: PackInputField[];
    };
    phases: PhaseDefinition[];
    cost_profile?: { max_rounds: number; default_reasoning: string };
    qa_rules?: { require_test_evidence: boolean; max_auto_fix_passes: number };
    staff?: {
      name_pool: Array<{ name: string; role: string; department: string }>;
      room_theme?: { floor1: string; floor2: string; wall: string; accent: string };
    };
    ui?: {
      slug?: string;
      label?: Record<string, string>;
      summary?: Record<string, string>;
      departments?: Record<string, unknown>;
      room_themes?: Record<string, unknown>;
      staff_cycle?: string[];
    };
  };
  guidanceLanguages: Record<string, string[]>;
}

export interface PackInputField {
  key: string;
  type: "string" | "number" | "boolean";
  label: Record<string, string>;
  default?: unknown;
  enum?: string[];
}

export interface PhaseDefinition {
  id: string;
  department: string;
  guidance: string;
  capability?: string;
  capability_mode?: "server" | "agent" | "hybrid";
  gate?: "auto" | "user_approval";
  skip_when?: string;
  node_type?: string;
  node_config?: Record<string, unknown>;
  on_review_fail?: { rerun: string; max_passes: number; flag_output: string };
  fan_out?: { count_from: string };
  inputs: Array<{ name: string; from: string }>;
  outputs: Array<{ name: string; type: string; path: string; schema?: string }>;
  hooks?: { pre_run?: string; post_run?: string };
}

/** Node Type metadata returned from GET /api/ops/node-types */
export interface NodeTypeInfo {
  key: string;
  meta: {
    label: string;
    description: string;
    icon: string;
    color: string;
    category: "collaboration" | "connector" | "control" | "custom";
    docsUrl?: string;
  };
  configSchema: NodeConfigField[];
  inputs: Array<{ name: string; type: string; label: string; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string; label: string; required: boolean; description?: string }>;
}

export interface NodeConfigField {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  label: string;
  description: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  required?: boolean;
}

/** Output type → port color mapping */
export const OUTPUT_TYPE_COLORS: Record<string, string> = {
  json: "#a78bfa",
  markdown: "#22d3ee",
  image: "#34d399",
  video: "#f59e0b",
  audio: "#f472b6",
  document: "#60a5fa",
};

export interface ValidationError {
  type: "broken_ref" | "cycle" | "orphan" | "duplicate_id" | "missing_output" | "empty_phase_id";
  phaseId: string;
  message: string;
  /** Which input caused the error (for broken_ref) */
  inputName?: string;
}

export type EditorMode = "visualizer" | "monitor" | "editor" | "builder";
