import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod/v4";
import type { Express } from "express";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AdapterRegistry } from "../../../adapters/index.ts";
import type { PackRegistry } from "../../../packs/pack-registry.ts";
import type { ConnectorRegistry } from "../../../connectors/registry.ts";
import type { NodeTypeRegistry } from "../../../node-types/node-type-registry.ts";
import { PackDefinitionSchema } from "../../../packs/pack-schema.ts";
import { buildGraph } from "../../../packs/graph-builder.ts";
import { PackLoader, type LoadedPack } from "../../../packs/pack-loader.ts";
import { resolveSessionWorkflowPackFromDb } from "../../../messenger/session-agent-routing.ts";
import { shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import {
  DEFAULT_WORKFLOW_PACK_KEY,
  DEFAULT_WORKFLOW_PACK_SEEDS,
  isWorkflowPackKey,
  WORKFLOW_PACK_KEYS,
  type WorkflowPackKey,
} from "../../workflow/packs/definitions.ts";

// ---------------------------------------------------------------------------
// Exported helpers (testable)
// ---------------------------------------------------------------------------

export interface LoadedPackPhaseEntry {
  id: string;
  department: string;
  fanOut?: boolean;
}

/**
 * Extract phase entries from a LoadedPack's definition.
 * Used by the /loaded endpoint to build the phase list for the Settings UI.
 */
export function extractPhases(pack: LoadedPack): LoadedPackPhaseEntry[] {
  return pack.definition.phases.map((p) => ({
    id: p.id,
    department: p.department,
    ...(p.fan_out ? { fanOut: true } : {}),
  }));
}

/** Validate pack key to prevent path traversal — only lowercase letters, digits, underscores, hyphens */
const SAFE_PACK_KEY = /^[a-z0-9_-]+$/;

/** Validate phase ID — lowercase alphanumeric, underscores, hyphens; must start with letter or digit */
const SAFE_PHASE_ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Validate language code — e.g. "en", "de", "pt-br" */
const SAFE_LANG = /^[a-z]{2}(-[a-z]{2})?$/;

/** Hard cap on number of phase positions persisted in a single PUT (DoS guard). */
export const MAX_POSITIONS_KEYS = 200;

/**
 * Schema for `PUT /api/ops/workflow-packs/:key/positions` body.
 * Shape: `Record<phaseId, { x: number, y: number }>` with finite numbers and
 * a hard cap on the number of entries to bound disk writes.
 */
export const PositionsBodySchema = z
  .record(
    z.string().min(1).max(64),
    z.strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
    }),
  )
  .refine((obj) => Object.keys(obj).length <= MAX_POSITIONS_KEYS, {
    message: `too_many_positions (max ${MAX_POSITIONS_KEYS})`,
  });

function assertSafePackKey(key: string): void {
  if (!SAFE_PACK_KEY.test(key) || key.length === 0 || key.length > 64) {
    throw new Error(`Invalid pack key: "${key}"`);
  }
}

/** Resolve a community pack directory and verify it's within the expected base */
function safeCommunityPath(key: string): string {
  assertSafePackKey(key);
  const base = path.resolve(process.cwd(), "server", "packs", "community");
  const resolved = path.resolve(base, key);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Path traversal detected: "${key}"`);
  }
  return resolved;
}

type WorkflowPackRow = {
  key: string;
  name: string;
  enabled: number;
  input_schema_json: string;
  prompt_preset_json: string;
  qa_rules_json: string;
  output_template_json: string;
  routing_keywords_json: string;
  cost_profile_json: string;
  created_at: number;
  updated_at: number;
};

type WorkflowRouteResult = {
  packKey: WorkflowPackKey;
  confidence: number;
  reason: string;
  candidates: Array<{ packKey: WorkflowPackKey; confidence: number; reason: string }>;
  requiresConfirmation: boolean;
};

function normalizeJsonStorageInput(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: "empty_json_text" };
    try {
      const parsed = JSON.parse(trimmed);
      return { ok: true, json: JSON.stringify(parsed) };
    } catch {
      return { ok: false, error: "invalid_json_text" };
    }
  }
  if (value === undefined) return { ok: false, error: "missing_json_value" };
  return { ok: true, json: JSON.stringify(value) };
}

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function classifyWorkflowPack(text: string): WorkflowRouteResult {
  const normalized = String(text || "").trim();
  const lower = normalized.toLowerCase();
  if (!lower) {
    return {
      packKey: DEFAULT_WORKFLOW_PACK_KEY,
      confidence: 0.35,
      reason: "empty_text",
      candidates: [{ packKey: DEFAULT_WORKFLOW_PACK_KEY, confidence: 0.35, reason: "empty_text" }],
      requiresConfirmation: true,
    };
  }

  const scoreByPack = new Map<WorkflowPackKey, number>();
  const addScore = (key: WorkflowPackKey, delta: number) => {
    scoreByPack.set(key, (scoreByPack.get(key) ?? 0) + delta);
  };

  const matcher = (re: RegExp): boolean => re.test(normalized) || re.test(lower);

  if (matcher(/(웹\s*서치|web\s*search|research|리서치|자료\s*조사|market\s*research|fact\s*check)/i))
    addScore("web_research_report", 0.78);
  if (matcher(/(보고서|리포트|brief|summary\s*report|status\s*report|executive\s*summary)/i))
    addScore("web_research_report", 0.74);
  if (
    matcher(
      /(design|mockup|wireframe|figma|ui\s*kit|design\s*system|token|palette|typography|a11y|accessibility|디자인|목업|와이어프레임|피그마|디자인\s*시스템|토큰|팔레트|타이포그래피|접근성)/i,
    )
  )
    addScore("design_studio", 0.8);
  if (matcher(/(영상|video|콘티|storyboard|shot\s*list|샷리스트|script\s*for\s*video|릴스|쇼츠)/i))
    addScore("video_preprod", 0.77);
  if (matcher(/(코드|개발|버그|테스트|fix|refactor|build|api|feature|deploy)/i)) addScore("development", 0.72);

  if (scoreByPack.size <= 0) {
    addScore("development", 0.5);
  }

  const sorted = Array.from(scoreByPack.entries())
    .map(([packKey, confidence]) => ({ packKey, confidence: Math.min(confidence, 0.98), reason: "keyword_match" }))
    .sort((a, b) => b.confidence - a.confidence);

  const top = sorted[0]!;
  const requiresConfirmation = top.confidence < 0.72;
  return {
    packKey: top.packKey,
    confidence: top.confidence,
    reason: top.reason,
    candidates: sorted.slice(0, 3),
    requiresConfirmation,
  };
}

interface WorkflowPackRouteBaseDeps {
  app: Express;
  db: DatabaseSync;
  nowMs(): number;
  normalizeTextField(value: unknown): string | null;
  adapterRegistry: AdapterRegistry;
  packRegistry?: PackRegistry;
  connectorRegistry?: ConnectorRegistry;
  nodeTypeRegistry?: NodeTypeRegistry;
}

export function registerWorkflowPackRoutes(ctx: WorkflowPackRouteBaseDeps): void {
  const { app, db, nowMs, normalizeTextField, packRegistry, adapterRegistry, connectorRegistry, nodeTypeRegistry } =
    ctx;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matching existing pattern
  function requireCsrfGuard(req: Parameters<typeof shouldRequireCsrf>[0], res: any): boolean {
    if (!shouldRequireCsrf(req)) return true;
    if (hasValidCsrfToken(req)) return true;
    res.status(403).json({ error: "csrf_token_invalid" });
    return false;
  }

  // ── Editor metadata: adapters, connectors, departments ──

  app.get("/api/ops/pack-editor/adapters", (_req, res) => {
    const adapters = adapterRegistry.list().map((a) => ({
      providerType: a.providerType,
      name: a.name,
      transport: a.transport,
    }));
    res.json({ adapters });
  });

  app.get("/api/ops/pack-editor/capabilities", (_req, res) => {
    if (!connectorRegistry) return res.json({ capabilities: [] });
    const connectors = connectorRegistry.listAll();
    const capabilities: Array<{ name: string; connector: string }> = [];
    for (const c of connectors) {
      for (const cap of c.capabilities) {
        capabilities.push({ name: cap.name, connector: c.name });
      }
    }
    res.json({ capabilities });
  });

  app.get("/api/ops/pack-editor/departments", (_req, res) => {
    try {
      const rows = db.prepare("SELECT id, name FROM departments ORDER BY name").all() as Array<{
        id: string;
        name: string;
      }>;
      res.json({ departments: rows });
    } catch {
      res.json({ departments: [] });
    }
  });

  // ── Workflow pack CRUD ──

  app.get("/api/workflow-packs", (_req, res) => {
    const rows = db
      .prepare(
        `
      SELECT *
      FROM workflow_packs
      ORDER BY
        CASE key
          WHEN 'development' THEN 1
          WHEN 'design_studio' THEN 2
          WHEN 'web_research_report' THEN 3
          WHEN 'video_preprod' THEN 4
          ELSE 99
        END,
        key
    `,
      )
      .all() as WorkflowPackRow[];

    if (rows.length <= 0) {
      const fallback = DEFAULT_WORKFLOW_PACK_SEEDS.map((pack) => ({
        key: pack.key,
        name: pack.name,
        enabled: true,
        input_schema: pack.inputSchema,
        prompt_preset: pack.promptPreset,
        qa_rules: pack.qaRules,
        output_template: pack.outputTemplate,
        routing_keywords: pack.routingKeywords,
        cost_profile: pack.costProfile,
      }));
      return res.json({ packs: fallback, source: "seed_fallback" });
    }

    const packs = rows.map((row) => ({
      key: row.key,
      name: row.name,
      enabled: row.enabled !== 0,
      input_schema: parseStoredJson(row.input_schema_json),
      prompt_preset: parseStoredJson(row.prompt_preset_json),
      qa_rules: parseStoredJson(row.qa_rules_json),
      output_template: parseStoredJson(row.output_template_json),
      routing_keywords: parseStoredJson(row.routing_keywords_json),
      cost_profile: parseStoredJson(row.cost_profile_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    return res.json({ packs });
  });

  // Pack metadata for office-workflow-pack.ts migration:
  // staff name pools, room theme keys, and phase counts per pack.
  app.get("/api/ops/workflow-packs/metadata", (_req, res) => {
    type LocalizedName = { ko: string; en: string; ja: string; zh: string; de?: string };
    type StaffPool = { department: string; names: LocalizedName[] };
    type PackMetadataEntry = {
      key: WorkflowPackKey;
      name: string;
      version: string;
      staff: StaffPool[];
      room_theme: string;
      phase_count: number;
    };

    const VIDEO_STAFF: StaffPool[] = [
      {
        department: "planning",
        names: [
          { ko: "비전", en: "Vision", ja: "ビジョン", zh: "Vision", de: "Vision" },
          { ko: "스크립트", en: "Script", ja: "スクリプト", zh: "Script", de: "Script" },
        ],
      },
      {
        department: "dev",
        names: [
          { ko: "픽셀", en: "Pixel", ja: "ピクセル", zh: "Pixel", de: "Pixel" },
          { ko: "클립", en: "Clip", ja: "クリップ", zh: "Clip", de: "Clip" },
        ],
      },
      {
        department: "qa",
        names: [{ ko: "렌즈", en: "Lens", ja: "レンズ", zh: "Lens", de: "Lens" }],
      },
    ];

    const RESEARCH_STAFF: StaffPool[] = [
      {
        department: "planning",
        names: [
          { ko: "세이지", en: "Sage", ja: "セージ", zh: "Sage", de: "Sage" },
          { ko: "스카우트", en: "Scout", ja: "スカウト", zh: "Scout", de: "Scout" },
        ],
      },
      {
        department: "dev",
        names: [
          { ko: "크롤", en: "Crawl", ja: "クロール", zh: "Crawl", de: "Crawl" },
          { ko: "아카이브", en: "Archive", ja: "アーカイブ", zh: "Archive", de: "Archive" },
          { ko: "스파이더", en: "Spider", ja: "スパイダー", zh: "Spider", de: "Spider" },
          { ko: "비콘", en: "Beacon", ja: "ビーコン", zh: "Beacon", de: "Beacon" },
          { ko: "인덱스", en: "Index", ja: "インデックス", zh: "Index", de: "Index" },
        ],
      },
      {
        department: "qa",
        names: [{ ko: "베리파이", en: "Verify", ja: "ベリファイ", zh: "Verify", de: "Verify" }],
      },
    ];

    const packMetaMap: Record<WorkflowPackKey, Omit<PackMetadataEntry, "name">> = {
      development: { key: "development", version: "1.0.0", staff: [], room_theme: "default", phase_count: 1 },
      design_studio: { key: "design_studio", version: "1.0.0", staff: [], room_theme: "design_studio", phase_count: 1 },
      video_preprod: {
        key: "video_preprod",
        version: "1.0.0",
        staff: VIDEO_STAFF,
        room_theme: "video_preprod",
        phase_count: 7, // concept, screenplay, image_generation, image_review, video_generation, voice_prep, assembly
      },
      web_research_report: {
        key: "web_research_report",
        version: "1.0.0",
        staff: RESEARCH_STAFF,
        room_theme: "web_research_report",
        phase_count: 5, // planning, crawl, synthesis, fact_check, final_report
      },
    };

    const dbRows = db.prepare("SELECT key, name FROM workflow_packs").all() as Array<{ key: string; name: string }>;
    const nameByKey = new Map(dbRows.map((row) => [row.key, row.name]));
    const seedNameByKey = new Map(DEFAULT_WORKFLOW_PACK_SEEDS.map((s) => [s.key, s.name]));

    const packs: PackMetadataEntry[] = WORKFLOW_PACK_KEYS.map((key) => ({
      ...packMetaMap[key],
      name: nameByKey.get(key) ?? seedNameByKey.get(key) ?? key,
    }));

    return res.json({ packs });
  });

  app.put("/api/workflow-packs/:key", (req, res) => {
    const packKey = String(req.params.key || "").trim();
    if (!isWorkflowPackKey(packKey)) return res.status(400).json({ error: "invalid_pack_key" });

    const existing = db.prepare("SELECT key FROM workflow_packs WHERE key = ?").get(packKey) as
      | { key: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: "pack_not_found" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: string[] = ["updated_at = ?"];
    const params: SQLInputValue[] = [nowMs()];

    if ("name" in body) {
      const name = normalizeTextField(body.name);
      if (!name) return res.status(400).json({ error: "name_required" });
      updates.push("name = ?");
      params.push(name);
    }
    if ("enabled" in body) {
      const enabled = body.enabled === false || body.enabled === 0 || String(body.enabled) === "0" ? 0 : 1;
      updates.push("enabled = ?");
      params.push(enabled);
    }

    const jsonFieldSpecs: Array<{ dbField: string; aliases: string[] }> = [
      { dbField: "input_schema_json", aliases: ["input_schema", "inputSchema", "input_schema_json"] },
      { dbField: "prompt_preset_json", aliases: ["prompt_preset", "promptPreset", "prompt_preset_json"] },
      { dbField: "qa_rules_json", aliases: ["qa_rules", "qaRules", "qa_rules_json"] },
      { dbField: "output_template_json", aliases: ["output_template", "outputTemplate", "output_template_json"] },
      { dbField: "routing_keywords_json", aliases: ["routing_keywords", "routingKeywords", "routing_keywords_json"] },
      { dbField: "cost_profile_json", aliases: ["cost_profile", "costProfile", "cost_profile_json"] },
    ];

    for (const spec of jsonFieldSpecs) {
      const alias = spec.aliases.find((candidate) => candidate in body);
      if (!alias) continue;
      const normalized = normalizeJsonStorageInput(body[alias]);
      if (!normalized.ok) {
        return res.status(400).json({ error: "invalid_json_field", field: alias, reason: normalized.error });
      }
      updates.push(`${spec.dbField} = ?`);
      params.push(normalized.json);
    }

    if (updates.length <= 1) return res.status(400).json({ error: "no_fields" });

    params.push(packKey);
    db.prepare(`UPDATE workflow_packs SET ${updates.join(", ")} WHERE key = ?`).run(...params);

    const row = db.prepare("SELECT * FROM workflow_packs WHERE key = ?").get(packKey) as WorkflowPackRow | undefined;
    if (!row) return res.status(500).json({ error: "pack_reload_failed" });

    return res.json({
      ok: true,
      pack: {
        key: row.key,
        name: row.name,
        enabled: row.enabled !== 0,
        input_schema: parseStoredJson(row.input_schema_json),
        prompt_preset: parseStoredJson(row.prompt_preset_json),
        qa_rules: parseStoredJson(row.qa_rules_json),
        output_template: parseStoredJson(row.output_template_json),
        routing_keywords: parseStoredJson(row.routing_keywords_json),
        cost_profile: parseStoredJson(row.cost_profile_json),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  });

  // GET /api/ops/workflow-packs/loaded — list loaded packs with phase info
  app.get("/api/ops/workflow-packs/loaded", (_req, res) => {
    type PhaseEntry = { id: string; department: string; fanOut?: boolean };
    type LoadedPackEntry = {
      key: WorkflowPackKey;
      name: string;
      version: string;
      source: "builtin" | "community";
      enabled: boolean;
      phaseCount: number;
      phases: PhaseEntry[];
    };

    const enabledRows = db.prepare("SELECT key, enabled, name FROM workflow_packs").all() as Array<{
      key: string;
      enabled: number;
      name: string;
    }>;
    const enabledMap = new Map(enabledRows.map((r) => [r.key, { enabled: r.enabled !== 0, name: r.name }]));
    const seedNameMap = new Map(DEFAULT_WORKFLOW_PACK_SEEDS.map((s) => [s.key, s.name]));

    const packs: LoadedPackEntry[] = WORKFLOW_PACK_KEYS.map((key) => {
      const dbEntry = enabledMap.get(key);
      const enabled = dbEntry?.enabled ?? true;
      const name = dbEntry?.name ?? seedNameMap.get(key) ?? key;

      // Read phases from PackRegistry (parsed from pack.yaml)
      let phases: PhaseEntry[] = [];
      let packVersion = "1.0.0";
      let packSource: "builtin" | "community" = "builtin";
      if (packRegistry) {
        try {
          const loadedPack = packRegistry.get(key);
          phases = extractPhases(loadedPack);
          packVersion = loadedPack.definition.pack.version ?? "1.0.0";
          packSource = loadedPack.source === "built-in" ? "builtin" : "community";
        } catch {
          // Pack not found in registry — leave phases empty
        }
      }

      return {
        key,
        name,
        version: packVersion,
        source: packSource,
        enabled,
        phaseCount: phases.length > 0 ? phases.length : 1,
        phases,
      };
    });

    return res.json({ packs });
  });

  // POST /api/ops/workflow-packs/reload — re-scan and reload all packs from DB seeds
  app.post("/api/ops/workflow-packs/reload", (_req, res) => {
    // Re-seed any missing packs from the canonical seed list
    const nowTs = nowMs();
    for (const seed of DEFAULT_WORKFLOW_PACK_SEEDS) {
      const existing = db.prepare("SELECT key FROM workflow_packs WHERE key = ?").get(seed.key) as
        | { key: string }
        | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO workflow_packs
             (key, name, enabled, input_schema_json, prompt_preset_json, qa_rules_json, output_template_json, routing_keywords_json, cost_profile_json, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          seed.key,
          seed.name,
          JSON.stringify(seed.inputSchema),
          JSON.stringify(seed.promptPreset),
          JSON.stringify(seed.qaRules),
          JSON.stringify(seed.outputTemplate),
          JSON.stringify(seed.routingKeywords),
          JSON.stringify(seed.costProfile),
          nowTs,
          nowTs,
        );
      }
    }

    const rows = db.prepare("SELECT key, name, enabled FROM workflow_packs").all() as Array<{
      key: string;
      name: string;
      enabled: number;
    }>;
    const packs = rows.map((r) => ({
      key: r.key,
      name: r.name,
      version: "1.0.0",
      source: "builtin",
      enabled: r.enabled !== 0,
    }));

    return res.json({ packs, reloaded: true });
  });

  app.get("/api/ops/workflow-packs/registry", (_req, res) => {
    if (!packRegistry) {
      return res.json({ packs: [] });
    }

    const allPacks = packRegistry.listEnabled();
    const entries = allPacks.map((pack) => {
      const def = pack.definition;
      const ui = def.ui;
      const staffPool = def.staff?.name_pool ?? [];
      const phaseDepts = def.phases.map((p) => p.department);
      const uniqueDepts = [...new Set(phaseDepts)];

      return {
        key: pack.key,
        source: pack.source,
        version: def.pack.version,
        name: def.pack.name,
        description: def.pack.description,
        phases: def.phases.map((p) => ({ id: p.id, department: p.department })),
        staff: def.staff
          ? {
              name_pool: staffPool.map((s) => ({
                name: { en: s.name, ko: s.name_ko ?? s.name, ja: s.name_ja ?? s.name, zh: s.name_zh ?? s.name },
                role: s.role,
                department: s.department,
              })),
              room_theme: def.staff.room_theme ?? null,
              default_workspace: def.staff.default_workspace ?? null,
            }
          : null,
        ui: {
          slug: ui?.slug ?? pack.key.slice(0, 4).toUpperCase(),
          label: ui?.label ?? def.pack.name,
          summary: ui?.summary ?? def.pack.description,
          departments: ui?.departments ?? {},
          room_themes: ui?.room_themes ?? {},
          staff_cycle: ui?.staff_cycle ?? uniqueDepts,
        },
        enabled: true,
      };
    });

    const builtIn = entries.filter((e) => e.source === "built-in");
    const community = entries.filter((e) => e.source === "community").sort((a, b) => a.key.localeCompare(b.key));

    res.json({ packs: [...builtIn, ...community] });
  });

  app.get("/api/ops/workflow-packs/:key/definition", (req, res) => {
    if (!packRegistry) {
      return res.status(503).json({ error: "Pack registry not available" });
    }

    const { key } = req.params;
    try {
      const pack = packRegistry.get(key);

      // Build guidance language map: { phaseId: ["en", "ko", ...] }
      const guidanceLanguages: Record<string, string[]> = {};
      for (const phase of pack.definition.phases) {
        const langs: string[] = [];
        for (const [cacheKey] of pack.guidanceCache) {
          const [phaseId, lang] = cacheKey.split(".");
          if (phaseId === phase.id && lang) langs.push(lang);
        }
        guidanceLanguages[phase.id] = langs.sort();
      }

      res.json({
        key: pack.key,
        source: pack.source,
        definition: pack.definition,
        guidanceLanguages,
      });
    } catch {
      res.status(404).json({ error: "Pack not found" });
    }
  });

  app.get("/api/ops/workflow-packs/:key/positions", (req, res) => {
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });

    const { key } = req.params;
    try {
      packRegistry.get(key);
    } catch {
      return res.status(404).json({ error: "Pack not found" });
    }

    const posPath = path.join(process.cwd(), "server", "packs", "community", key, ".positions.json");
    if (fs.existsSync(posPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(posPath, "utf-8"));
        return res.json(data);
      } catch {
        return res.json(null);
      }
    }
    res.json(null);
  });

  app.put("/api/ops/workflow-packs/:key/positions", (req, res) => {
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });

    const { key } = req.params;
    try {
      packRegistry.get(key);
    } catch {
      return res.status(404).json({ error: "Pack not found" });
    }

    const parsed = PositionsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_positions_body", details: parsed.error.issues });
    }

    const posDir = safeCommunityPath(key);
    if (!fs.existsSync(posDir)) fs.mkdirSync(posDir, { recursive: true });

    const posPath = path.join(posDir, ".positions.json");
    fs.writeFileSync(posPath, JSON.stringify(parsed.data, null, 2));
    res.json({ ok: true });
  });

  // ── Guidance CRUD ──

  app.get("/api/ops/workflow-packs/:key/guidance/:phaseId", (req, res) => {
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });
    const { key, phaseId } = req.params;
    if (!SAFE_PHASE_ID.test(phaseId) || phaseId.length > 64) {
      return res.status(400).json({ error: `Invalid phase ID: "${phaseId}"` });
    }
    try {
      const pack = packRegistry.get(key);
      const langs: string[] = [];
      for (const [cacheKey] of pack.guidanceCache) {
        const [pid, lang] = cacheKey.split(".");
        if (pid === phaseId && lang) langs.push(lang);
      }
      res.json({ phaseId, languages: langs.sort() });
    } catch {
      res.status(404).json({ error: "Pack not found" });
    }
  });

  app.get("/api/ops/workflow-packs/:key/guidance/:phaseId/:lang", (req, res) => {
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });
    const { key, phaseId, lang } = req.params;
    if (!SAFE_PHASE_ID.test(phaseId) || phaseId.length > 64) {
      return res.status(400).json({ error: `Invalid phase ID: "${phaseId}"` });
    }
    if (!SAFE_LANG.test(lang)) {
      return res.status(400).json({ error: `Invalid language code: "${lang}"` });
    }
    try {
      const pack = packRegistry.get(key);
      const content = pack.guidanceCache.get(`${phaseId}.${lang}`);
      if (content === undefined) {
        return res.status(404).json({ error: `Guidance not found: ${phaseId}.${lang}` });
      }
      res.json({ phaseId, lang, content });
    } catch {
      res.status(404).json({ error: "Pack not found" });
    }
  });

  app.put("/api/ops/workflow-packs/:key/guidance/:phaseId/:lang", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });
    const { key, phaseId, lang } = req.params;
    if (!SAFE_PHASE_ID.test(phaseId) || phaseId.length > 64) {
      return res.status(400).json({ error: `Invalid phase ID: "${phaseId}"` });
    }
    if (!SAFE_LANG.test(lang)) {
      return res.status(400).json({ error: `Invalid language code: "${lang}"` });
    }
    try {
      const pack = packRegistry.get(key);
      // Built-in packs: save guidance as community override
      const content = typeof req.body?.content === "string" ? req.body.content : "";
      const guidanceBase = path.resolve(process.cwd(), "server", "packs", "community");
      const guidanceDir = path.resolve(guidanceBase, key, "guidance");
      if (!guidanceDir.startsWith(guidanceBase + path.sep)) {
        return res.status(400).json({ error: "Path traversal detected" });
      }
      const filePath = path.resolve(guidanceDir, `${phaseId}.${lang}.md`);
      if (!filePath.startsWith(guidanceDir + path.sep)) {
        return res.status(400).json({ error: "Path traversal detected" });
      }
      if (!fs.existsSync(guidanceDir)) fs.mkdirSync(guidanceDir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      // Update cache
      pack.guidanceCache.set(`${phaseId}.${lang}`, content);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: "Pack not found" });
    }
  });

  // ── Pack Editor: validate + save ──

  app.post("/api/ops/workflow-packs/validate", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const result = PackDefinitionSchema.safeParse(body);
    if (!result.success) {
      return res.status(400).json({
        valid: false,
        errors: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    try {
      buildGraph(result.data.pack.key, result.data.phases);
      res.json({ valid: true, errors: [] });
    } catch (e) {
      res
        .status(400)
        .json({ valid: false, errors: [{ path: "phases", message: e instanceof Error ? e.message : String(e) }] });
    }
  });

  app.put("/api/ops/workflow-packs/:key/definition", async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });

    const { key } = req.params;

    // Built-in packs are saved as community overrides
    try {
      packRegistry.get(key);
    } catch {
      // New pack — will be created in community/
    }

    const body = req.body as Record<string, unknown>;
    const result = PackDefinitionSchema.safeParse(body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    // Validate graph structure
    try {
      buildGraph(result.data.pack.key, result.data.phases);
    } catch (e) {
      return res
        .status(400)
        .json({ error: "Graph validation failed", message: e instanceof Error ? e.message : String(e) });
    }

    // Write pack.yaml
    const packDir = safeCommunityPath(key);
    if (!fs.existsSync(packDir)) fs.mkdirSync(packDir, { recursive: true });

    const yamlStr = yaml.dump(result.data, { indent: 2, lineWidth: 120, noRefs: true });
    fs.writeFileSync(path.join(packDir, "pack.yaml"), yamlStr, "utf-8");

    // Reload the pack into registry
    try {
      const loader = new PackLoader();
      const packs = await loader.loadAll(
        path.join(process.cwd(), "server", "packs", "built-in"),
        path.join(process.cwd(), "server", "packs", "community"),
      );
      packRegistry.load(packs);
    } catch {
      // Non-fatal — pack is saved but registry may be stale until restart
    }

    res.json({ ok: true, key });
  });

  // ── Pack Create + Delete ──

  app.post("/api/ops/workflow-packs/create", async (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    const body = req.body as Record<string, unknown>;
    const result = PackDefinitionSchema.safeParse(body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    const key = result.data.pack.key;
    const packDir = safeCommunityPath(key);
    if (fs.existsSync(path.join(packDir, "pack.yaml"))) {
      return res.status(409).json({ error: `Pack "${key}" already exists` });
    }

    try {
      buildGraph(key, result.data.phases);
    } catch (e) {
      return res
        .status(400)
        .json({ error: "Graph validation failed", message: e instanceof Error ? e.message : String(e) });
    }

    fs.mkdirSync(packDir, { recursive: true });
    const yamlStr = yaml.dump(result.data, { indent: 2, lineWidth: 120, noRefs: true });
    fs.writeFileSync(path.join(packDir, "pack.yaml"), yamlStr, "utf-8");

    // Create guidance directory
    fs.mkdirSync(path.join(packDir, "guidance"), { recursive: true });

    // Reload registry
    if (packRegistry) {
      try {
        const loader = new PackLoader();
        const packs = await loader.loadAll(
          path.join(process.cwd(), "server", "packs", "built-in"),
          path.join(process.cwd(), "server", "packs", "community"),
        );
        packRegistry.load(packs);
      } catch {
        /* non-fatal */
      }
    }

    res.json({ ok: true, key });
  });

  app.delete("/api/ops/workflow-packs/:key", (req, res) => {
    if (!requireCsrfGuard(req, res)) return;
    if (!packRegistry) return res.status(503).json({ error: "Pack registry not available" });
    const { key } = req.params;

    try {
      const pack = packRegistry.get(key);
      if (pack.source === "built-in") {
        return res.status(403).json({ error: "Cannot delete built-in packs" });
      }
    } catch {
      return res.status(404).json({ error: "Pack not found" });
    }

    const packDir = safeCommunityPath(key);
    if (fs.existsSync(packDir)) {
      fs.rmSync(packDir, { recursive: true });
    }

    res.json({ ok: true });
  });

  app.post("/api/workflow/route", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = normalizeTextField(body.text) ?? "";
    const explicitPackKey = normalizeTextField(body.workflow_pack_key ?? body.packKey);
    const sessionKey = normalizeTextField(body.session_key ?? body.sessionKey);
    const projectId = normalizeTextField(body.project_id ?? body.projectId);

    const enabledRows = db.prepare("SELECT key FROM workflow_packs WHERE enabled = 1").all() as Array<{ key: string }>;
    const enabledSet = new Set<WorkflowPackKey>(
      enabledRows.map((row) => row.key).filter((rowKey): rowKey is WorkflowPackKey => isWorkflowPackKey(rowKey)),
    );
    const isEnabled = (packKey: WorkflowPackKey): boolean => enabledSet.size <= 0 || enabledSet.has(packKey);

    if (explicitPackKey && isWorkflowPackKey(explicitPackKey) && isEnabled(explicitPackKey)) {
      return res.json({
        packKey: explicitPackKey,
        confidence: 1,
        reason: "explicit_request",
        candidates: [{ packKey: explicitPackKey, confidence: 1, reason: "explicit_request" }],
        requiresConfirmation: false,
      });
    }

    if (sessionKey) {
      const sessionPack = resolveSessionWorkflowPackFromDb({ db, sessionKey });
      if (sessionPack && isEnabled(sessionPack)) {
        return res.json({
          packKey: sessionPack,
          confidence: 0.95,
          reason: "session_default",
          candidates: [{ packKey: sessionPack, confidence: 0.95, reason: "session_default" }],
          requiresConfirmation: false,
        });
      }
    }

    if (projectId) {
      const row = db.prepare("SELECT default_pack_key FROM projects WHERE id = ?").get(projectId) as
        | { default_pack_key?: string | null }
        | undefined;
      const projectPack = normalizeTextField(row?.default_pack_key);
      if (projectPack && isWorkflowPackKey(projectPack) && isEnabled(projectPack)) {
        return res.json({
          packKey: projectPack,
          confidence: 0.9,
          reason: "project_default",
          candidates: [{ packKey: projectPack, confidence: 0.9, reason: "project_default" }],
          requiresConfirmation: false,
        });
      }
    }

    const inferred = classifyWorkflowPack(text);
    const inferredEnabled = isEnabled(inferred.packKey)
      ? inferred
      : {
          ...inferred,
          packKey: DEFAULT_WORKFLOW_PACK_KEY,
          confidence: Math.min(inferred.confidence, 0.6),
          reason: "inferred_pack_disabled",
          requiresConfirmation: true,
        };
    return res.json(inferredEnabled);
  });

  // GET /api/ops/node-types — list all registered node types for the Graph Editor palette
  app.get("/api/ops/node-types", (_req, res) => {
    if (!nodeTypeRegistry) {
      return res.json([]);
    }
    const types = nodeTypeRegistry.list().map((def) => ({
      key: def.key,
      meta: def.meta,
      configSchema: def.configSchema,
      inputs: def.inputs,
      outputs: def.outputs,
      // execute() is a function — not serializable, intentionally excluded
    }));
    res.json(types);
  });
}
