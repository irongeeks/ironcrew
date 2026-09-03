// server/node-types/node-type-interface.ts

/**
 * The database interface used by GraphRunner — node types receive the same
 * interface so they can read task/subtask state if needed.
 */
export interface NodeDatabase {
  run(sql: string, ...params: unknown[]): unknown;
  get(sql: string, ...params: unknown[]): unknown;
  all(sql: string, ...params: unknown[]): unknown;
  exec?(sql: string): void;
}

/**
 * Minimal connector-registry interface exposed to node types.
 * Allows connector-wrapping nodes (e.g. comfyui_generate, web_search) to
 * invoke capabilities without importing the full ConnectorRegistry.
 */
export interface NodeConnectorRegistry {
  executeCapability(
    capability: string,
    input: Record<string, unknown>,
  ): Promise<{
    status: "success" | "error" | "timeout";
    artifacts: Array<{ path: string; type: string; metadata?: Record<string, unknown> }>;
    costInfo?: { tokens?: number; credits?: number; durationMs: number };
    error?: string;
  }>;
  hasBinding(capability: string): boolean;
  getAgentGuidance(capability: string, lang: string): string | null;
}

/**
 * Context passed to NodeTypeDefinition.execute().
 * All values are fully resolved — no need to look up pack refs yourself.
 */
export interface NodeExecuteContext {
  /** ID of the parent task */
  taskId: string;

  /** ID of the current phase (e.g. "planning", "image_generation") */
  phaseId: string;

  /**
   * Resolved input values. Keys match the `name` fields from the node's
   * `inputs` schema. Values were loaded from prior-phase artifacts by
   * the graph-runner before this function is called.
   */
  inputs: Record<string, unknown>;

  /**
   * Static config values from `node_config` in pack.yaml.
   * Keys match the `key` fields in `configSchema`. Missing fields
   * are filled with their `default` value from the schema.
   */
  config: Record<string, unknown>;

  /** Database access for reading/writing task and subtask state */
  db: NodeDatabase;

  /**
   * Connector registry — allows connector-wrapping nodes to invoke
   * registered capabilities (e.g. text2img, web_search) without tight coupling.
   * Optional — not all environments provide this (e.g. tests).
   */
  connectorRegistry?: NodeConnectorRegistry;

  /**
   * WebSocket broadcast — send real-time updates to the dashboard.
   * Example: broadcast("subtask_update", { taskId, phaseId, status: "in_progress" })
   * Optional — not all environments provide this.
   */
  broadcast?: (type: string, payload: unknown) => void;

  /** ISO 639-1 language code of the user session (e.g. "en", "de", "ko") */
  lang: string;
}

/**
 * What execute() must return.
 */
export interface NodeExecuteResult {
  /**
   * - "success"           → phase done, downstream phases unblocked
   * - "error"             → phase failed, workflow stops
   * - "awaiting_approval" → phase paused, user must approve before continuing
   *                         (same as `gate: "user_approval"` on a normal phase)
   */
  status: "success" | "error" | "awaiting_approval";

  /**
   * Output values. Keys match the `name` fields in the node's `outputs` schema.
   * These are saved as artifacts and available to downstream phases via `from:`.
   */
  outputs: Record<string, unknown>;

  /**
   * Short human-readable description of what happened.
   * Appears in the Task Log in the dashboard.
   * Example: "Planning meeting completed — 4 action items generated"
   */
  summary?: string;

  /** Error message. Required when status is "error". */
  error?: string;
}

/**
 * One field in the node's static configuration (node_config in pack.yaml).
 * Every field MUST have a description — this text appears in the Graph Editor
 * directly under the field label so users know what to enter.
 */
export interface NodeConfigField {
  /** Key as used in node_config (snake_case, e.g. "max_rounds") */
  key: string;

  /** The data type of this field */
  type: "string" | "number" | "boolean" | "select";

  /** Human-readable label shown in the Graph Editor (e.g. "Maximum Meeting Rounds") */
  label: string;

  /**
   * Explanation shown directly under the label in the Graph Editor.
   * Tell the user WHAT this field does and give a hint about good values.
   * Example: "How many discussion rounds the planning meeting runs (recommended: 3–5)"
   */
  description: string;

  /** Default value used when node_config does not include this key */
  default?: string | number | boolean;

  /** For type "select" only — the list of allowed values */
  options?: Array<{ value: string; label: string }>;

  /** For type "number" only — minimum allowed value */
  min?: number;

  /** For type "number" only — maximum allowed value */
  max?: number;

  /** When true, the workflow will not start if this field is missing or empty */
  required?: boolean;
}

/**
 * One input or output port on a node.
 * Ports are the connection points in the Graph Editor.
 */
export interface NodePortSchema {
  /**
   * Internal name — used in `from:` references in pack.yaml.
   * Example: if outputs has name "plan_items", a downstream phase
   * can use `from: "planning.plan_items"`.
   */
  name: string;

  /**
   * Data type — determines the color of the connection line in the editor:
   * string/number/boolean → grey  |  json → purple  |  markdown → cyan
   * image → green  |  video → amber  |  audio → pink  |  document → blue
   */
  type: "string" | "number" | "boolean" | "markdown" | "json" | "image" | "video" | "audio" | "document";

  /** Human-readable name shown on the port in the editor (e.g. "Planning Result") */
  label: string;

  /** Whether this port must be connected for the workflow to run */
  required: boolean;

  /** What data this port contains or expects. Shown as a tooltip in the editor. */
  description?: string;
}

/**
 * The full definition of a node type. Export a value that satisfies this
 * interface as the default export of your index.ts file.
 *
 * @example
 * ```ts
 * // server/node-types/community/my-node/index.ts
 * import type { NodeTypeDefinition } from "../../node-type-interface";
 *
 * const MyNode: NodeTypeDefinition = {
 *   key: "my_node",
 *   meta: { label: "My Node", description: "...", icon: "🔧", color: "#aaa", category: "custom" },
 *   configSchema: [],
 *   inputs: [],
 *   outputs: [],
 *   async execute(ctx) {
 *     return { status: "success", outputs: {}, summary: "done" };
 *   },
 * };
 *
 * export default MyNode;
 * ```
 */
export interface NodeTypeDefinition {
  /**
   * Unique key for this node type — referenced in pack.yaml as `node_type: <key>`.
   * Format: snake_case, e.g. "planning_meeting", "comfyui_generate"
   * Must be unique across built-in and community node types.
   * Community node types with the same key as a built-in override the built-in.
   */
  key: string;

  /** Display metadata for the Graph Editor and documentation */
  meta: {
    /** Short name shown in the editor node palette (e.g. "Planning Meeting") */
    label: string;

    /** One sentence describing what this node type does */
    description: string;

    /** Emoji or path to an SVG file used as the node icon */
    icon: string;

    /** Hex colour used for the node border and header in the editor */
    color: string;

    /**
     * Category determines which group this node appears under in the palette:
     * - "collaboration": multi-agent orchestration (meetings, cross-dept handoffs)
     * - "connector":     external service integrations (ComfyUI, web search, APIs)
     * - "control":       flow control (gates, conditions, fan-out)
     * - "custom":        everything else (community nodes)
     */
    category: "collaboration" | "connector" | "control" | "custom";

    /** URL to the detailed documentation page for this node type */
    docsUrl?: string;
  };

  /**
   * Configuration fields that can be set in node_config in pack.yaml.
   * These appear as a form in the Property Panel of the Graph Editor.
   * Every field MUST have a `description` — see NodeConfigField.
   */
  configSchema: NodeConfigField[];

  /** Inputs this node receives from earlier phases or from the pack input */
  inputs: NodePortSchema[];

  /** Outputs this node produces for downstream phases */
  outputs: NodePortSchema[];

  /**
   * The execution logic. Called by the graph-runner when this phase is reached.
   * Run any async work here — call external APIs, spawn sub-processes, etc.
   * The graph-runner waits for this promise before advancing the workflow.
   */
  execute(context: NodeExecuteContext): Promise<NodeExecuteResult>;

  /**
   * Optional: returns text injected into the agent prompt.
   * Only relevant for "hybrid" nodes where an agent works alongside the node.
   */
  getAgentGuidance?(context: NodeExecuteContext, lang: string): string;

  /**
   * Optional: verifies that the external service this node talks to is reachable.
   * Called from the Settings UI when a user configures a connector-based node.
   */
  testConnection?(config: Record<string, unknown>): Promise<{
    ok: boolean;
    message: string;
  }>;
}
