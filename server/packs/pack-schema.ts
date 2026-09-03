import { z } from "zod/v4";

export const PhaseOutputSchema = z.object({
  name: z.string(),
  type: z.enum(["markdown", "json", "image", "video", "audio", "document"]),
  path: z.string(),
  schema: z.string().optional(),
});

export type PhaseOutput = z.infer<typeof PhaseOutputSchema>;

export const PhaseInputSchema = z.object({
  name: z.string(),
  from: z.string(),
});

export type PhaseInput = z.infer<typeof PhaseInputSchema>;

export const OnReviewFailSchema = z.object({
  rerun: z.string(),
  max_passes: z.number().int().min(1).default(2),
  flag_output: z.string(),
});

export type OnReviewFail = z.infer<typeof OnReviewFailSchema>;

export const PhaseHooksSchema = z.object({
  pre_run: z.string().optional(),
  post_run: z.string().optional(),
});

export type PhaseHooks = z.infer<typeof PhaseHooksSchema>;

export const PhaseSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      "Phase ID must start with a letter and contain only lowercase letters, digits, and underscores",
    ),
  department: z.string(),
  guidance: z.string().regex(/\{lang\}/, "Guidance path must contain {lang} placeholder"),
  capability: z.string().optional(),
  capability_mode: z.enum(["server", "agent", "hybrid"]).default("agent"),
  gate: z.enum(["auto", "user_approval"]).default("auto"),
  skip_when: z.string().optional(),
  on_review_fail: OnReviewFailSchema.optional(),
  fan_out: z.object({ count_from: z.string() }).optional(),
  inputs: z.array(PhaseInputSchema).default([]),
  outputs: z.array(PhaseOutputSchema).default([]),
  hooks: PhaseHooksSchema.optional(),
  /** Key of the NodeTypeDefinition to execute for this phase (e.g. "planning_meeting"). */
  node_type: z.string().optional(),
  /** Static configuration values passed to the node type's execute() as ctx.config. */
  node_config: z.record(z.string(), z.unknown()).optional(),
});

export type Phase = z.infer<typeof PhaseSchema>;

export const PackInputFieldSchema = z.object({
  key: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  label: z.record(z.string(), z.string()),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
});

export type PackInputField = z.infer<typeof PackInputFieldSchema>;

export const CostProfileSchema = z.object({
  max_rounds: z.number().int().default(5),
  max_input_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  default_reasoning: z.enum(["low", "medium", "high"]).default("medium"),
});

export type CostProfile = z.infer<typeof CostProfileSchema>;

export const QaRulesSchema = z.object({
  require_test_evidence: z.boolean().default(false),
  max_auto_fix_passes: z.number().int().default(2),
});

export type QaRules = z.infer<typeof QaRulesSchema>;

export const StaffMemberSchema = z.object({
  name: z.string(),
  role: z.enum(["team_leader", "agent"]),
  department: z.string(),
  name_ko: z.string().optional(),
  name_ja: z.string().optional(),
  name_zh: z.string().optional(),
  avatar_emoji: z.string().optional(),
  sprite_number: z.number().optional(),
  personality: z.string().optional(),
});

export type StaffMember = z.infer<typeof StaffMemberSchema>;

export const StaffSchema = z.object({
  name_pool: z.array(StaffMemberSchema),
  room_theme: z
    .object({
      floor1: z.string(),
      floor2: z.string(),
      wall: z.string(),
      accent: z.string(),
    })
    .optional(),
  // A-001 (#88): default_workspace is consumed by execution-run.ts as a
  // path segment under process.cwd() when auto-creating a workspace dir.
  // Reject anything that could escape the application root.
  // Allowed shape: one or more `[a-z0-9_-]` segments separated by `/`.
  default_workspace: z
    .string()
    .regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/, "default_workspace must be a relative path with [a-z0-9_-] segments")
    .refine((v) => !v.includes(".."), { message: "default_workspace must not contain '..'" })
    .optional(),
});

export type Staff = z.infer<typeof StaffSchema>;

const UiDepartmentSchema = z.object({
  name: z.record(z.string(), z.string()).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  agent_prefix: z.record(z.string(), z.string()).optional(),
  avatar_pool: z.array(z.string()).optional(),
});

const UiRoomThemeValueSchema = z.union([z.number(), z.string()]);
const UiRoomThemeSchema = z.object({
  floor1: UiRoomThemeValueSchema.optional(),
  floor2: UiRoomThemeValueSchema.optional(),
  wall: UiRoomThemeValueSchema.optional(),
  accent: UiRoomThemeValueSchema.optional(),
});

const UiSchema = z.object({
  slug: z.string().max(5).optional(),
  label: z.record(z.string(), z.string()).optional(),
  summary: z.record(z.string(), z.string()).optional(),
  departments: z.record(z.string(), UiDepartmentSchema).optional(),
  room_themes: z.record(z.string(), UiRoomThemeSchema).optional(),
  staff_cycle: z.array(z.string()).optional(),
});

export const PackDefinitionSchema = z.object({
  pack: z.object({
    key: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "Pack key must start with a letter and contain only lowercase letters, digits, and underscores",
      ),
    name: z.record(z.string(), z.string()),
    version: z.string(),
    schema_version: z.literal(1),
    description: z.record(z.string(), z.string()),
    icon: z.string().optional(),
    agent_routing: z.enum(["department", "single"]).default("department"),
    shared_guidance: z
      .string()
      .regex(/\{lang\}/, "Shared guidance path must contain {lang} placeholder")
      .optional(),
  }),
  input: z.object({
    required: z.array(PackInputFieldSchema).default([]),
    optional: z.array(PackInputFieldSchema).default([]),
  }),
  phases: z.array(PhaseSchema).min(1),
  cost_profile: CostProfileSchema.optional(),
  qa_rules: QaRulesSchema.optional(),
  staff: StaffSchema.optional(),
  ui: UiSchema.optional(),
});

export type PackDefinition = z.infer<typeof PackDefinitionSchema>;
export type PackUiDefinition = z.infer<typeof UiSchema>;
export type PackUiDepartment = z.infer<typeof UiDepartmentSchema>;
export type PackUiRoomTheme = z.infer<typeof UiRoomThemeSchema>;
