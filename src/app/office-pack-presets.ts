// TODO: Read staff pools and room themes from pack registry API instead of hardcoded values
import type { AgentRole, RoomTheme, WorkflowPackKey } from "../types";

export type UiLanguageLike = "ko" | "en" | "ja" | "zh" | "de";

export type Localized = { ko: string; en: string; ja: string; zh: string; de?: string };
export type DeptPreset = {
  name: Localized;
  icon: string;
  agentPrefix: Localized;
  avatarPool: string[];
};

export type StaffPreset = {
  nonLeaderDeptCycle: string[];
  roleTitles?: Partial<Record<AgentRole, Localized>>;
  planningLeadDeptIds?: string[];
};

export type SeedProfile = {
  nameOffset: number;
  tone: Localized;
};

export type PackPreset = {
  key: WorkflowPackKey;
  slug: string;
  label: Localized;
  summary: Localized;
  roomThemes: Record<string, RoomTheme>;
  departments: Partial<Record<string, DeptPreset>>;
  staff?: StaffPreset;
};

export type OfficePackPresentation = {
  departments: import("../types").Department[];
  agents: import("../types").Agent[];
  roomThemes: Record<string, RoomTheme>;
};

export type OfficePackStarterAgentDraft = {
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  department_id: string | null;
  seed_order_in_department: number;
  role: AgentRole;
  acts_as_planning_leader: number;
  avatar_emoji: string;
  sprite_number: number;
  personality: string | null;
};

export type OfficePackSeedProvider = Extract<import("../types").CliProvider, "claude" | "codex">;
export const OFFICE_SEED_SPRITE_POOL = Array.from({ length: 13 }, (_, idx) => idx + 1);

export const DEV_THEMES: Record<string, RoomTheme> = {
  ceoOffice: { floor1: 0xe5d9b9, floor2: 0xdfd0a8, wall: 0x998243, accent: 0xa77d0c },
  planning: { floor1: 0xf0e1c5, floor2: 0xeddaba, wall: 0xae9871, accent: 0xd4a85a },
  dev: { floor1: 0xd8e8f5, floor2: 0xcce1f2, wall: 0x6c96b7, accent: 0x5a9fd4 },
  design: { floor1: 0xe8def2, floor2: 0xe1d4ee, wall: 0x9378ad, accent: 0x9a6fc4 },
  qa: { floor1: 0xf0cbcb, floor2: 0xedc0c0, wall: 0xae7979, accent: 0xd46a6a },
  breakRoom: { floor1: 0xf7e2b7, floor2: 0xf6dead, wall: 0xa99c83, accent: 0xf0c878 },
};

export const PACK_SEED_PROFILE: Partial<Record<WorkflowPackKey, SeedProfile>> = {
  design_studio: {
    nameOffset: 5,
    tone: {
      ko: "디자인 산출물의 일관성, 접근성, 핸드오프 명확성을 우선합니다.",
      en: "Prioritizes design consistency, accessibility, and clear handoff quality.",
      ja: "デザイン成果物の一貫性・アクセシビリティ・ハンドオフ明確性を最優先します。",
      zh: "Prioritizes design consistency, accessibility, and clear handoff quality.",
      de: "Priorisiert Designkonsistenz, Barrierefreiheit und klare Übergabequalität.",
    },
  },
  web_research_report: {
    nameOffset: 1,
    tone: {
      ko: "출처 신뢰도와 사실 검증을 중심으로 움직입니다.",
      en: "Focused on source credibility and fact verification.",
      ja: "情報源の信頼性と事実検証を中心に進めます。",
      zh: "Focused on source credibility and fact verification.",
      de: "Fokussiert auf Quellenglaubwürdigkeit und Faktenverifizierung.",
    },
  },
  video_preprod: {
    nameOffset: 3,
    tone: {
      ko: "ComfyUI 파이프라인 품질, 비주얼 일관성, 프로덕션 효율을 우선합니다.",
      en: "Prioritizes ComfyUI pipeline quality, visual consistency, and production efficiency.",
      ja: "ComfyUIパイプライン品質、ビジュアルの一貫性、制作効率を優先します。",
      zh: "Prioritizes ComfyUI pipeline quality, visual consistency, and production efficiency.",
      de: "Priorisiert ComfyUI-Pipeline-Qualität, visuelle Konsistenz und Produktionseffizienz.",
    },
  },
};

export const PACK_PRESETS: Record<WorkflowPackKey, PackPreset> = {
  development: {
    key: "development",
    slug: "DEV",
    label: {
      ko: "개발 오피스",
      en: "Development Office",
      ja: "開発オフィス",
      zh: "Development Office",
      de: "Entwicklungsbüro",
    },
    summary: {
      ko: "기본 개발 조직 구조",
      en: "Default engineering organization",
      ja: "標準の開発組織",
      zh: "Default engineering organization",
      de: "Standard-Entwicklungsorganisation",
    },
    roomThemes: DEV_THEMES,
    departments: {},
  },
  design_studio: {
    key: "design_studio",
    slug: "DSN",
    label: {
      ko: "디자인 스튜디오",
      en: "Design Studio",
      ja: "デザインスタジオ",
      zh: "Design Studio",
      de: "Design-Studio",
    },
    summary: {
      ko: "UI 설계, 디자인 시스템, 접근성 검증 중심",
      en: "UI design, design systems, and accessibility-first workflow",
      ja: "UI設計・デザインシステム・アクセシビリティ検証中心",
      zh: "UI design, design systems, and accessibility-first workflow",
      de: "UI-Design, Designsysteme und barrierefreiheitsorientierter Workflow",
    },
    roomThemes: {
      ceoOffice: { floor1: 0xf1e8df, floor2: 0xecdfd3, wall: 0x8f6e5f, accent: 0xc48563 },
      planning: { floor1: 0xecf0f8, floor2: 0xe1e9f5, wall: 0x61708f, accent: 0x6682b3 },
      dev: { floor1: 0xe4edf0, floor2: 0xd9e6ed, wall: 0x506d7a, accent: 0x5b90a8 },
      design: { floor1: 0xfaece7, floor2: 0xf2dfd6, wall: 0x9a6f62, accent: 0xe08b67 },
      qa: { floor1: 0xebf2ee, floor2: 0xe0ebe5, wall: 0x5f7e74, accent: 0x5ca789 },
      breakRoom: { floor1: 0xf5eee2, floor2: 0xeee3d1, wall: 0x8c816b, accent: 0xc3a46e },
    },
    departments: {
      planning: {
        name: {
          ko: "디자인기획실",
          en: "Design Planning",
          ja: "デザイン企画室",
          zh: "Design Planning",
          de: "Designplanung",
        },
        icon: "🧭",
        agentPrefix: { ko: "디자인 PM", en: "Design PM", ja: "デザインPM", zh: "Design PM", de: "Design PM" },
        avatarPool: ["🧭", "🗂️", "📌"],
      },
      design: {
        name: { ko: "UI디자인팀", en: "UI Design", ja: "UIデザインチーム", zh: "UI Design", de: "UI-Design" },
        icon: "🎨",
        agentPrefix: { ko: "UI 디자이너", en: "UI Designer", ja: "UIデザイナー", zh: "UI Designer", de: "UI-Designer" },
        avatarPool: ["🎨", "🧩", "🖼️"],
      },
      qa: {
        name: { ko: "디자인QA팀", en: "Design QA", ja: "デザインQA", zh: "Design QA", de: "Design-QA" },
        icon: "🔎",
        agentPrefix: { ko: "디자인 QA", en: "Design QA", ja: "デザインQA", zh: "Design QA", de: "Design-QA" },
        avatarPool: ["🔎", "✅", "♿"],
      },
      dev: {
        name: {
          ko: "핸드오프엔지니어링",
          en: "Handoff Engineering",
          ja: "ハンドオフ実装",
          zh: "Handoff Engineering",
          de: "Übergabe-Engineering",
        },
        icon: "🧩",
        agentPrefix: {
          ko: "핸드오프 엔지니어",
          en: "Handoff Engineer",
          ja: "ハンドオフエンジニア",
          zh: "Handoff Engineer",
          de: "Übergabe-Ingenieur",
        },
        avatarPool: ["🧩", "💻", "⚙️"],
      },
    },
    staff: {
      nonLeaderDeptCycle: ["design", "design", "qa", "planning", "dev", "design", "qa", "planning"],
      planningLeadDeptIds: ["planning"],
    },
  },
  web_research_report: {
    key: "web_research_report",
    slug: "WEB",
    label: {
      ko: "웹 리서치 오피스",
      en: "Web Research Office",
      ja: "Web調査オフィス",
      zh: "Web Research Office",
      de: "Web-Recherchebüro",
    },
    summary: {
      ko: "소스 수집과 근거 검증 중심",
      en: "Source collection and citation verification",
      ja: "情報源収集と根拠検証中心",
      zh: "Source collection and citation verification",
      de: "Quellensammlung und Zitationsverifizierung",
    },
    roomThemes: {
      ceoOffice: { floor1: 0xddebf1, floor2: 0xd2e3eb, wall: 0x4e6f7f, accent: 0x3d90b5 },
      planning: { floor1: 0xe2eef6, floor2: 0xd8e7f1, wall: 0x55728d, accent: 0x5f95c6 },
      dev: { floor1: 0xe2f1ef, floor2: 0xd8ebe8, wall: 0x4d7a72, accent: 0x4fa69a },
      design: { floor1: 0xeceff7, floor2: 0xe2e8f2, wall: 0x606c88, accent: 0x748ec5 },
      qa: { floor1: 0xf0f3f7, floor2: 0xe6ecf2, wall: 0x5d6f80, accent: 0x7a93b0 },
      breakRoom: { floor1: 0xe8f0f4, floor2: 0xdce8ef, wall: 0x5f7380, accent: 0x7ca0b9 },
    },
    departments: {
      planning: {
        name: {
          ko: "조사전략실",
          en: "Research Strategy",
          ja: "調査戦略室",
          zh: "Research Strategy",
          de: "Forschungsstrategie",
        },
        icon: "🧭",
        agentPrefix: {
          ko: "전략 분석가",
          en: "Strategy Analyst",
          ja: "戦略アナリスト",
          zh: "Strategy Analyst",
          de: "Strategieanalyst",
        },
        avatarPool: ["🧭", "🗺️", "📌"],
      },
      dev: {
        name: { ko: "크롤링팀", en: "Crawler Team", ja: "クロール班", zh: "Crawler Team", de: "Crawler-Team" },
        icon: "🕸️",
        agentPrefix: {
          ko: "수집 엔지니어",
          en: "Collection Engineer",
          ja: "収集エンジニア",
          zh: "Collection Engineer",
          de: "Sammlungsingenieur",
        },
        avatarPool: ["🕸️", "🔗", "🧠"],
      },
      qa: {
        name: { ko: "팩트체크팀", en: "Fact Check", ja: "ファクトチェック", zh: "Fact Check", de: "Faktencheck" },
        icon: "✅",
        agentPrefix: { ko: "검증관", en: "Verifier", ja: "検証官", zh: "Verifier", de: "Prüfer" },
        avatarPool: ["✅", "🔍", "📎"],
      },
    },
    staff: {
      nonLeaderDeptCycle: ["dev", "dev", "planning", "dev", "qa", "dev", "dev", "planning"],
    },
  },
  video_preprod: {
    key: "video_preprod",
    slug: "VID",
    label: {
      ko: "영상 프로덕션 파이프라인",
      en: "Video Production Pipeline",
      ja: "映像プロダクションパイプライン",
      zh: "Video Production Pipeline",
      de: "Videoproduktions-Pipeline",
    },
    summary: {
      ko: "ComfyUI 기반 이미지/비디오 생성 파이프라인",
      en: "ComfyUI-based image/video generation pipeline",
      ja: "ComfyUIベースの画像/動画生成パイプライン",
      zh: "ComfyUI-based image/video generation pipeline",
      de: "ComfyUI-basierte Bild-/Videogenerierungs-Pipeline",
    },
    roomThemes: {
      ceoOffice: { floor1: 0x1f1f25, floor2: 0x17171c, wall: 0x343748, accent: 0xd18d35 },
      planning: { floor1: 0x25212b, floor2: 0x1c1923, wall: 0x44405b, accent: 0xbc7d47 },
      dev: { floor1: 0x1d2631, floor2: 0x17202a, wall: 0x334961, accent: 0x4c8fca },
      design: { floor1: 0x2a2230, floor2: 0x211a27, wall: 0x544063, accent: 0xc274b7 },
      qa: { floor1: 0x2a2425, floor2: 0x211d1f, wall: 0x5a494b, accent: 0xb98862 },
      breakRoom: { floor1: 0x2a2622, floor2: 0x211d1a, wall: 0x564c43, accent: 0xbd8a49 },
    },
    departments: {
      planning: {
        name: {
          ko: "크리에이티브 디렉션",
          en: "Creative Direction",
          ja: "クリエイティブディレクション",
          zh: "Creative Direction",
          de: "Kreative Leitung",
        },
        icon: "🎬",
        agentPrefix: {
          ko: "크리에이티브 디렉터",
          en: "Creative Director",
          ja: "クリエイティブディレクター",
          zh: "Creative Director",
          de: "Kreativdirektor",
        },
        avatarPool: ["🎬", "📽️", "🧭"],
      },
      dev: {
        name: {
          ko: "비주얼 프로덕션",
          en: "Visual Production",
          ja: "ビジュアルプロダクション",
          zh: "Visual Production",
          de: "Visuelle Produktion",
        },
        icon: "🖼️",
        agentPrefix: {
          ko: "비주얼 아티스트",
          en: "Visual Artist",
          ja: "ビジュアルアーティスト",
          zh: "Visual Artist",
          de: "Visueller Künstler",
        },
        avatarPool: ["🖼️", "🎨", "🎞️"],
      },
      qa: {
        name: { ko: "비주얼 QA", en: "Visual QA", ja: "ビジュアルQA", zh: "Visual QA", de: "Visuelles QA" },
        icon: "✅",
        agentPrefix: {
          ko: "비주얼 검수관",
          en: "Visual Reviewer",
          ja: "ビジュアルレビュア",
          zh: "Visual Reviewer",
          de: "Visueller Prüfer",
        },
        avatarPool: ["✅", "🔎", "🧪"],
      },
    },
    staff: {
      nonLeaderDeptCycle: ["planning", "dev", "dev", "qa", "planning", "dev", "qa", "planning"],
    },
  },
};
