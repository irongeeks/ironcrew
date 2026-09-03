const BUILT_IN_PACK_KEYS = ["development", "design_studio", "video_preprod", "web_research_report"] as const;

export type BuiltInPackKey = (typeof BUILT_IN_PACK_KEYS)[number];
export type WorkflowPackKey = string;

export const DEFAULT_WORKFLOW_PACK_KEY: BuiltInPackKey = "development";

// Keep backward-compat alias
export const WORKFLOW_PACK_KEYS = BUILT_IN_PACK_KEYS;

export function isWorkflowPackKey(value: unknown): value is WorkflowPackKey {
  if (typeof value !== "string") return false;
  // Accept built-in pack keys directly.
  if ((WORKFLOW_PACK_KEYS as readonly string[]).includes(value)) return true;
  // Also accept any valid pack key format (supports community packs).
  return /^[a-z_]+$/.test(value) && value.length > 0 && value.length <= 64;
}

export type WorkflowPackSeed = {
  key: WorkflowPackKey;
  name: string;
  inputSchema: Record<string, unknown>;
  promptPreset: Record<string, unknown>;
  qaRules: Record<string, unknown>;
  outputTemplate: Record<string, unknown>;
  routingKeywords: string[];
  costProfile: Record<string, unknown>;
};

const COMMON_COST_PROFILE = {
  maxInputTokens: 12000,
  maxOutputTokens: 6000,
  maxRounds: 3,
};

export const DEFAULT_WORKFLOW_PACK_SEEDS: WorkflowPackSeed[] = [
  {
    key: "development",
    name: "Development",
    inputSchema: {
      required: [],
      optional: ["constraints", "acceptance_criteria", "deadline"],
    },
    promptPreset: {
      mode: "engineering",
      phases: ["analysis", "planning", "implementation", "review"],
      description:
        "Development workflow: analysis → planning → implementation → review. Follow the phase guidance. Produce outputs in dev_output/.",
    },
    qaRules: {
      requireTestEvidence: true,
      requireRiskNotes: true,
      maxAutoFixPasses: 1,
    },
    outputTemplate: {
      sections: ["summary", "changes", "verification", "next_steps"],
    },
    routingKeywords: ["fix", "bug", "refactor", "build", "api", "test", "개발", "버그", "수정", "코드"],
    costProfile: {
      ...COMMON_COST_PROFILE,
      defaultReasoning: "high",
    },
  },
  {
    key: "design_studio",
    name: "Design Studio",
    inputSchema: {
      required: ["design_goal", "target_surface", "brand_constraints"],
      optional: ["figma_url", "accessibility_target", "component_inventory", "handoff_scope"],
    },
    promptPreset: {
      mode: "design_studio",
      phases: ["brief", "exploration", "execution", "handoff"],
      description:
        "Design Studio workflow: brief → exploration → execution → handoff. Follow the phase guidance. Save outputs to design_output/.",
    },
    qaRules: {
      requireDesignReviewChain: ["design_agent", "qa_agent", "ceo_approval"],
      requireA11yChecks: ["contrast", "focus_order", "hit_target"],
      requireHandoffFields: ["components", "tokens", "states", "implementation_notes"],
      maxAutoFixPasses: 2,
    },
    outputTemplate: {
      sections: [
        "design_brief",
        "mockup_summary",
        "design_tokens",
        "accessibility_audit",
        "design_review_notes",
        "design_to_code_handoff",
      ],
      handoffSchema: {
        format: "json",
        required: [
          "components",
          "tokens",
          "interaction_states",
          "layout_rules",
          "implementation_notes",
          "asset_manifest",
        ],
      },
    },
    routingKeywords: [
      "design",
      "mockup",
      "figma",
      "ui system",
      "design token",
      "color palette",
      "typography",
      "accessibility audit",
      "handoff",
      "디자인",
      "목업",
      "피그마",
      "디자인 시스템",
      "디자인 토큰",
      "컬러 팔레트",
      "타이포그래피",
      "접근성",
      "핸드오프",
    ],
    costProfile: {
      ...COMMON_COST_PROFILE,
      maxInputTokens: 14000,
      defaultReasoning: "high",
    },
  },
  {
    key: "video_preprod",
    name: "Video Production Pipeline",
    inputSchema: {
      required: ["topic", "platform", "duration"],
      optional: ["style", "mood", "target_audience", "cta", "reference_description", "max_regen_cycles"],
    },
    promptPreset: {
      mode: "video_production_pipeline",
      phases: [
        "concept",
        "screenplay",
        "image_generation",
        "image_review",
        "video_generation",
        "voice_prep",
        "assembly",
      ],
      useComfyUi: true,
    },
    qaRules: {
      requireShotList: true,
      requireScript: true,
      requireRenderedVideo: true,
      requireComfyUiServer: true,
    },
    outputTemplate: {
      sections: [
        "concept_pitch",
        "screenplay",
        "shot_list",
        "generated_images",
        "generated_video",
        "voiceover_script",
        "final_video",
      ],
    },
    routingKeywords: ["video", "shorts", "reel", "콘티", "영상", "대본", "샷리스트"],
    costProfile: {
      ...COMMON_COST_PROFILE,
      maxRounds: 2,
      defaultReasoning: "medium",
    },
  },
  {
    key: "web_research_report",
    name: "Web Research Report",
    inputSchema: {
      required: ["topic", "time_range"],
      optional: ["source_policy", "language", "depth"],
    },
    promptPreset: {
      mode: "web_research_pipeline",
      phases: ["planning", "crawl", "synthesis", "fact_check", "final_report"],
      requireCitations: true,
      supportedDepths: ["quick", "standard", "deep"],
    },
    qaRules: {
      failWithoutCitations: true,
      citationStyle: "inline_links",
    },
    outputTemplate: {
      sections: ["summary", "findings", "citations", "recommendations"],
    },
    routingKeywords: ["research", "web search", "investigate", "조사", "웹서치", "자료조사", "리서치"],
    costProfile: {
      ...COMMON_COST_PROFILE,
      maxRounds: 5,
      defaultReasoning: "high",
    },
  },
];
