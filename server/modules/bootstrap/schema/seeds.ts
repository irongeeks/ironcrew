import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedDefaultWorkflowPacks } from "./workflow-pack-seeds.ts";
import { logger } from "../../../observability/logger.ts";

const log = logger.child({ module: "bootstrap" });

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

const DEFAULT_DEPARTMENT_TEXT: Record<string, { description: string; prompt: string }> = {
  research: {
    description:
      "Research team. Investigates codebases, reproduces bugs, analyzes root causes, and builds context before planning.",
    prompt: `[Department Standards — Research]

Your job is to understand before anyone acts. Every insight you produce becomes the foundation for planning and implementation.

Workflow:
1. Read the task description and all referenced files/modules thoroughly.
2. For bug tasks: reproduce the issue first. Document exact steps, expected vs actual behavior, and the environment.
3. Trace the code path involved. Identify root cause or the relevant entry points for new work.
4. Check git history for related changes (git log, git blame on affected files).
5. Document unknowns and risks — what could break, what's unclear, what needs user input.

Output standards:
- Every claim must reference a specific file:line or commit hash.
- Clearly separate facts (what you observed) from hypotheses (what you think is happening).
- If you can't reproduce a bug, say so — don't guess.
- Keep output structured: Summary → Findings → Root Cause / Entry Points → Risks → Recommendations.`,
  },
  planning: {
    description:
      "Planning team. Translates research and requirements into executable plans with concrete steps and acceptance criteria.",
    prompt: `[Department Standards — Planning]

You translate research findings and requirements into executable plans. A good plan means the developer can start coding without questions.

Workflow:
1. Read all prior phase outputs (research findings, requirements, scope).
2. Define the technical approach: which files to create/modify, what patterns to follow, how to handle edge cases.
3. Break work into ordered, independently committable steps. Each step should have clear inputs and outputs.
4. Define acceptance criteria: specific, testable conditions that prove the task is done.
5. Define the testing strategy: what tests to write, what coverage is expected.

Output standards:
- Steps must be concrete: "Add validation to parseInput() in src/utils/parser.ts" not "handle input validation".
- Reference existing code patterns. Check how similar things are done in the codebase before proposing new patterns.
- Flag scope decisions: what's in scope, what's explicitly out of scope, what's deferred.
- For architecture phases: justify technology choices with trade-offs, not opinions.`,
  },
  dev: {
    description: "Development team. Writes production-ready code following plans, with tests alongside implementation.",
    prompt: `[Department Standards — Development]

You write production-ready code. Your output is source code, not documents about source code.

Workflow:
1. Read the plan and task breakdown from the planning phase.
2. Follow the plan step by step. If the plan is wrong or incomplete, flag it — don't silently deviate.
3. Write the actual source code files. Create directories, configs, and dependencies as needed.
4. Write tests alongside implementation (not after).
5. Run tests to confirm they pass before marking work as done.
6. Prepare a commit for each logical change with a clear commit message.

Output standards:
- Minimal change surface: only touch files the plan specifies. Do not refactor unrelated code.
- Follow existing codebase conventions (naming, formatting, import style, error handling patterns).
- Every function that can fail should have error handling at system boundaries.
- No dead code, no commented-out code, no TODOs without issue references.
- If you scaffold a new project: full working setup (package.json, tsconfig, src/, tests/).`,
  },
  testing: {
    description:
      "Testing team. Validates implementations through comprehensive test suites, regression testing, and quality verification.",
    prompt: `[Department Standards — Testing]

You validate that the implementation works correctly and doesn't break existing functionality.

Workflow:
1. Read the plan, acceptance criteria, and implementation summary.
2. Review existing tests — understand what's already covered.
3. Write new tests for:
   - Every acceptance criterion (happy path)
   - Edge cases identified in planning/research
   - Error paths and boundary conditions
   - Regression: ensure nothing previously working is broken
4. Run the full relevant test suite (unit + integration + E2E where applicable).
5. Document test results with evidence (pass/fail counts, coverage delta).

Output standards:
- Tests must be deterministic — no flaky tests, no timing dependencies.
- Test names describe the behavior being tested, not the implementation.
- One assertion per test where practical. Multiple assertions only when testing a single logical behavior.
- Mock external services only — never mock internal modules unless absolutely necessary.
- If tests fail: document the failure clearly with reproduction steps, don't silently skip.`,
  },
  review: {
    description:
      "Review team. Performs code review, security audits, and final sign-off as the last gate before completion.",
    prompt: `[Department Standards — Review]

You are the last gate before work is considered done. Your job is to catch what others missed.

Workflow:
1. Read the full chain: research findings → plan → implementation changes → test results.
2. Code review checklist:
   - Does the implementation match the plan? Any unauthorized deviations?
   - Are all acceptance criteria met with evidence?
   - Are tests comprehensive? Do they cover edge cases from the research phase?
   - Security: injection, XSS, auth bypass, data exposure, input validation
   - Performance: N+1 queries, unnecessary allocations, missing indexes
   - Maintainability: naming, complexity, documentation where non-obvious
3. Verdict: approve or reject. No middle ground.

Output standards:
- Every issue must have: severity (critical/major/minor), file:line, what's wrong, how to fix it.
- Critical/major issues → reject. The task goes back for fixes.
- Minor issues → approve with notes. Don't block progress for style preferences.
- If you approve: state explicitly what you verified and how.
- Never rubber-stamp. If you can't find issues, look harder — check error paths, concurrency, and data boundaries.`,
  },
  design: {
    description:
      "Design team. Produces UI/UX direction, interaction quality, and design-system-consistent deliverables.",
    prompt:
      "[Department Role] Design\n[Execution Standard] Translate requirements into coherent UI proposals, justify visual decisions, and provide implementation-ready handoff notes.",
  },
  qa: {
    description:
      "QA team. Verifies behavior, detects regressions, enforces release quality signals, and reviews security posture.",
    prompt:
      "[Department Role] QA\n[Execution Standard] Validate expected vs actual behavior, document reproducible findings with severity, ensure test coverage for changed paths, and review security implications of changes.",
  },
};

export function applyDefaultSeeds(db: DbLike): void {
  seedDefaultWorkflowPacks(db);

  const deptCount = (db.prepare("SELECT COUNT(*) as cnt FROM departments").get() as { cnt: number }).cnt;

  if (deptCount === 0) {
    const insertDept = db.prepare(
      "INSERT INTO departments (id, name, name_ko, name_ja, name_zh, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertDept.run("research", "Research", "Research Team", "Research Team", "Research Team", "🔍", "#06b6d4", 1);
    insertDept.run("planning", "Planning", "Planning Team", "Planning Team", "Planning Team", "📐", "#f59e0b", 2);
    insertDept.run(
      "dev",
      "Development",
      "Development Team",
      "Development Team",
      "Development Team",
      "💻",
      "#3b82f6",
      3,
    );
    insertDept.run("testing", "Testing", "Testing Team", "Testing Team", "Testing Team", "🧪", "#10b981", 4);
    insertDept.run("review", "Review", "Review Team", "Review Team", "Review Team", "🛡️", "#ef4444", 5);
    // Keep design & qa for other packs (design_studio, etc.)
    insertDept.run("design", "Design", "Design Team", "Design Team", "Design Team", "🎨", "#8b5cf6", 6);
    insertDept.run("qa", "QA/QC", "QA Team", "QA Team", "QA Team", "🔍", "#ef4444", 7);
    log.info("seeded default departments");
  }

  const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as { cnt: number }).cnt;

  if (agentCount === 0) {
    const insertAgent = db.prepare(
      `INSERT INTO agents (id, name, name_ko, department_id, role, cli_provider, avatar_emoji, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Research (2)
    insertAgent.run(
      randomUUID(),
      "Tom",
      "Tom",
      "research",
      "team_leader",
      "claude",
      "🔎",
      "Methodical investigator. Traces every code path to its origin. Doesn't speculate — reads the code.",
    );
    insertAgent.run(
      randomUUID(),
      "Elsa",
      "Elsa",
      "research",
      "senior",
      "claude",
      "📖",
      "Patient analyst. Cross-references git history, docs, and runtime behavior to build complete context.",
    );
    // Planning (2)
    insertAgent.run(
      randomUUID(),
      "Tim",
      "Tim",
      "planning",
      "team_leader",
      "claude",
      "📐",
      "Pragmatic architect. Breaks complex problems into small, safe steps. Favors proven patterns over clever solutions.",
    );
    insertAgent.run(
      randomUUID(),
      "Greta",
      "Greta",
      "planning",
      "senior",
      "claude",
      "🗺️",
      "Structured planner. Creates detailed task breakdowns with explicit dependencies and acceptance criteria.",
    );
    // Development (3)
    insertAgent.run(
      randomUUID(),
      "Doreen",
      "Doreen",
      "dev",
      "team_leader",
      "claude",
      "👩‍💻",
      "Senior engineer. Writes clean, minimal code. Tests alongside implementation. Follows the plan, flags deviations.",
    );
    insertAgent.run(
      randomUUID(),
      "Kurt",
      "Kurt",
      "dev",
      "senior",
      "claude",
      "⚡",
      "Fast, focused implementer. Efficient code with strong test coverage. Prefers small commits.",
    );
    insertAgent.run(
      randomUUID(),
      "Lena",
      "Lena",
      "dev",
      "junior",
      "claude",
      "🌟",
      "Diligent junior. Follows established patterns carefully. Asks when unsure rather than guessing.",
    );
    // Testing (2)
    insertAgent.run(
      randomUUID(),
      "Mona",
      "Mona",
      "testing",
      "team_leader",
      "claude",
      "🧪",
      "Thorough test engineer. Writes deterministic tests. Covers happy paths, edge cases, and regressions.",
    );
    insertAgent.run(
      randomUUID(),
      "Dieter",
      "Dieter",
      "testing",
      "senior",
      "claude",
      "🔬",
      "Detail-oriented tester. Hunts for edge cases, race conditions, and boundary failures.",
    );
    // Review (1)
    insertAgent.run(
      randomUUID(),
      "Astrid",
      "Astrid",
      "review",
      "team_leader",
      "claude",
      "🛡️",
      "Rigorous reviewer. Checks security, performance, and plan compliance. Doesn't rubber-stamp.",
    );
    // Design (2) — needed by design_studio pack
    insertAgent.run(
      randomUUID(),
      "Ingrid",
      "Ingrid",
      "design",
      "team_leader",
      "claude",
      "🎨",
      "Design lead. Translates requirements into coherent UI proposals, justifies visual decisions, and provides implementation-ready handoff notes.",
    );
    insertAgent.run(
      randomUUID(),
      "Mia",
      "Mia",
      "design",
      "junior",
      "claude",
      "🌙",
      "UI designer. Creates mockups, explores visual variants, and ensures design-system consistency.",
    );
    // QA (1) — needed by design_studio pack review gate
    insertAgent.run(
      randomUUID(),
      "Nele",
      "Nele",
      "qa",
      "team_leader",
      "claude",
      "🦅",
      "Quality lead. Validates expected vs actual behavior, documents reproducible findings with severity, ensures test coverage, and reviews security posture.",
    );
    log.info("seeded default agents");
  }

  try {
    const serverCount = (db.prepare("SELECT COUNT(*) as cnt FROM servers").get() as { cnt: number }).cnt;
    if (serverCount === 0) {
      const insertServer = db.prepare(
        `
        INSERT INTO servers (
          id, name, type, endpoint_url, auth_config_json, max_concurrent_jobs, current_jobs,
          status, enabled, department_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      const t = Date.now();
      insertServer.run(
        randomUUID(),
        "ComfyUI Node A",
        "comfyui",
        "http://127.0.0.1:8188",
        null,
        2,
        0,
        "idle",
        1,
        "dev",
        JSON.stringify({ preset: "comfyui", purpose: "image_generation" }),
        t,
        t,
      );
      insertServer.run(
        randomUUID(),
        "LLM Gateway",
        "llm_api",
        "https://api.openai.com/v1",
        null,
        4,
        0,
        "idle",
        1,
        "dev",
        JSON.stringify({ preset: "llm_api", provider: "openai" }),
        t,
        t,
      );
      insertServer.run(
        randomUUID(),
        "Artifact Storage",
        "file_storage",
        "https://storage.example.internal",
        null,
        8,
        0,
        "idle",
        1,
        "dev",
        JSON.stringify({ preset: "file_storage" }),
        t,
        t,
      );
      insertServer.run(
        randomUUID(),
        "Primary Database",
        "database",
        "postgres://db.internal:5432/ironcrew",
        null,
        6,
        0,
        "idle",
        1,
        "dev",
        JSON.stringify({ preset: "database" }),
        t,
        t,
      );
      log.info("seeded default server resources");
    }
  } catch {
    // Ignore when server schema is unavailable during legacy bootstrap windows.
  }

  // Read setup.json if it exists (created by CLI wizard)
  const setupConfig: { company_name?: string; ceo_name?: string; default_provider?: string } = {};
  const setupJsonPath = path.resolve("setup.json");
  try {
    const raw = fs.readFileSync(setupJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.company_name === "string" && parsed.company_name.length <= 50) {
        setupConfig.company_name = parsed.company_name;
      }
      if (typeof parsed.ceo_name === "string" && parsed.ceo_name.length <= 50) {
        setupConfig.ceo_name = parsed.ceo_name;
      }
      if (typeof parsed.default_provider === "string") {
        setupConfig.default_provider = parsed.default_provider;
      }
    }
    try {
      fs.unlinkSync(setupJsonPath);
      log.info("consumed setup.json");
    } catch {
      log.warn("could not delete setup.json");
    }
  } catch {
    // File doesn't exist or is invalid — use defaults
  }

  // Seed default settings if none exist
  {
    const defaultRoomThemes = {
      ceoOffice: { accent: 0xa77d0c, floor1: 0xe5d9b9, floor2: 0xdfd0a8, wall: 0x998243 },
      research: { accent: 0x06b6d4, floor1: 0xd0ecec, floor2: 0xc5e5e5, wall: 0x6b9e9e },
      planning: { accent: 0xd4a85a, floor1: 0xf0e1c5, floor2: 0xeddaba, wall: 0xae9871 },
      dev: { accent: 0x5a9fd4, floor1: 0xd8e8f5, floor2: 0xcce1f2, wall: 0x6c96b7 },
      testing: { accent: 0x10b981, floor1: 0xd0f0e0, floor2: 0xc5ebd5, wall: 0x71ae8b },
      review: { accent: 0xd46a6a, floor1: 0xf0cbcb, floor2: 0xedc0c0, wall: 0xae7979 },
      breakRoom: { accent: 0xf0c878, floor1: 0xf7e2b7, floor2: 0xf6dead, wall: 0xa99c83 },
    };

    const settingsCount = (db.prepare("SELECT COUNT(*) as c FROM settings").get() as { c: number }).c;
    const isLegacySettingsInstall = settingsCount > 0;
    if (settingsCount === 0) {
      const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      insertSetting.run("companyName", setupConfig.company_name || "IronCrew");
      insertSetting.run("ceoName", setupConfig.ceo_name || "CEO");
      insertSetting.run("autoAssign", "true");
      insertSetting.run("yoloMode", "false");
      insertSetting.run("autoUpdateEnabled", "false");
      insertSetting.run("autoUpdateNoticePending", "false");
      insertSetting.run("oauthAutoSwap", "true");
      insertSetting.run("language", "en");
      insertSetting.run("defaultProvider", setupConfig.default_provider || "claude");
      insertSetting.run(
        "providerModelConfig",
        JSON.stringify({
          claude: { model: "claude-sonnet-4-6", subModel: "claude-opus-4-6" },
          codex: {
            model: "gpt-5.3-codex",
            reasoningLevel: "xhigh",
            subModel: "gpt-5.3-codex",
            subModelReasoningLevel: "high",
          },
          gemini: { model: "gemini-3-pro-preview" },
          opencode: { model: "github-copilot/claude-sonnet-4.6" },
          copilot: { model: "github-copilot/claude-sonnet-4.6" },
          antigravity: { model: "google/antigravity-gemini-3-pro" },
        }),
      );
      insertSetting.run("roomThemes", JSON.stringify(defaultRoomThemes));
      log.info("seeded default settings");
    }

    const hasLanguageSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'language' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasLanguageSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("language", "en");
    }

    const hasOAuthAutoSwapSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'oauthAutoSwap' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasOAuthAutoSwapSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("oauthAutoSwap", "true");
    }

    const hasAutoUpdateEnabledSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'autoUpdateEnabled' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasAutoUpdateEnabledSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("autoUpdateEnabled", "false");
    }

    const hasYoloModeSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'yoloMode' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasYoloModeSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("yoloMode", "false");
    }

    const hasAutonomousModeSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'autonomousMode' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasAutonomousModeSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("autonomousMode", "false");
    }

    const hasAutonomousMaxConcurrentSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'autonomousMaxConcurrent' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasAutonomousMaxConcurrentSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("autonomousMaxConcurrent", "2");
    }

    const hasCeoOrchestratorEnabledSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'ceoOrchestratorEnabled' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasCeoOrchestratorEnabledSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ceoOrchestratorEnabled", "false");
    }

    const hasCeoOrchestratorIntervalMsSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'ceoOrchestratorIntervalMs' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasCeoOrchestratorIntervalMsSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ceoOrchestratorIntervalMs", "120000");
    }

    const hasAutoUpdateNoticePendingSetting = db
      .prepare("SELECT 1 FROM settings WHERE key = 'autoUpdateNoticePending' LIMIT 1")
      .get() as { 1: number } | undefined;
    if (!hasAutoUpdateNoticePendingSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "autoUpdateNoticePending",
        isLegacySettingsInstall ? "true" : "false",
      );
    }

    const hasRoomThemesSetting = db.prepare("SELECT 1 FROM settings WHERE key = 'roomThemes' LIMIT 1").get() as
      | { 1: number }
      | undefined;
    if (!hasRoomThemesSetting) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "roomThemes",
        JSON.stringify(defaultRoomThemes),
      );
    }
  }

  // Migrate: add skipped_phases column to tasks if missing
  try {
    db.exec("ALTER TABLE tasks ADD COLUMN skipped_phases TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // Column already exists
  }

  // Migrate: add sort_order column & set correct ordering for existing DBs
  {
    try {
      db.exec("ALTER TABLE agents ADD COLUMN acts_as_planning_leader INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    try {
      db.exec(`
        UPDATE agents
        SET acts_as_planning_leader = CASE
          WHEN role = 'team_leader' AND department_id = 'planning' THEN 1
          ELSE COALESCE(acts_as_planning_leader, 0)
        END
      `);
    } catch {
      /* best effort */
    }

    try {
      db.exec("ALTER TABLE departments ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 99");
    } catch {
      /* already exists */
    }

    // Temporarily drop unique index -> update values -> recreate index (avoid conflicts)
    try {
      db.exec("DROP INDEX IF EXISTS idx_departments_sort_order");
    } catch {
      /* noop */
    }
    const DEPT_ORDER: Record<string, number> = {
      research: 1,
      planning: 2,
      dev: 3,
      testing: 4,
      review: 5,
    };

    const insertDeptIfMissing = db.prepare(
      "INSERT OR IGNORE INTO departments (id, name, name_ko, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertDeptIfMissing.run("research", "Research", "Research Team", "🔍", "#06b6d4", 1);
    insertDeptIfMissing.run("testing", "Testing", "Testing Team", "🧪", "#10b981", 4);
    insertDeptIfMissing.run("review", "Review", "Review Team", "🛡️", "#ef4444", 5);

    const updateDescriptionIfMissing = db.prepare(
      "UPDATE departments SET description = ? WHERE id = ? AND (description IS NULL OR trim(description) = '')",
    );
    const updatePromptIfMissing = db.prepare(
      "UPDATE departments SET prompt = ? WHERE id = ? AND (prompt IS NULL OR trim(prompt) = '')",
    );
    for (const [departmentId, text] of Object.entries(DEFAULT_DEPARTMENT_TEXT)) {
      updateDescriptionIfMissing.run(text.description, departmentId);
      updatePromptIfMissing.run(text.prompt, departmentId);
    }

    const updateOrder = db.prepare("UPDATE departments SET sort_order = ? WHERE id = ?");
    for (const [id, order] of Object.entries(DEPT_ORDER)) {
      updateOrder.run(order, id);
    }

    const allDepartments = db
      .prepare("SELECT id, sort_order FROM departments ORDER BY sort_order ASC, id ASC")
      .all() as Array<{ id: string; sort_order: number }>;
    const existingDeptIds = new Set(allDepartments.map((row) => row.id));
    const usedOrders = new Set<number>();
    for (const [id, order] of Object.entries(DEPT_ORDER)) {
      if (!existingDeptIds.has(id)) continue;
      usedOrders.add(order);
    }

    let nextOrder = 1;
    for (const row of allDepartments) {
      if (Object.prototype.hasOwnProperty.call(DEPT_ORDER, row.id)) continue;
      while (usedOrders.has(nextOrder)) nextOrder += 1;
      updateOrder.run(nextOrder, row.id);
      usedOrders.add(nextOrder);
      nextOrder += 1;
    }

    try {
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_sort_order ON departments(sort_order)");
    } catch (err) {
      log.warn({ err }, "failed to recreate idx_departments_sort_order");
    }

    const insertAgentIfMissing = db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, name_ko, department_id, role, cli_provider, avatar_emoji, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Check which agents exist by name to avoid duplicates
    const existingNames = new Set(
      (db.prepare("SELECT name FROM agents").all() as { name: string }[]).map((r) => r.name),
    );

    const newAgents: [string, string, string, string, string, string, string][] = [
      [
        "Tom",
        "Tom",
        "research",
        "team_leader",
        "claude",
        "🔎",
        "Methodical investigator. Traces every code path to its origin. Doesn't speculate — reads the code.",
      ],
      [
        "Elsa",
        "Elsa",
        "research",
        "senior",
        "claude",
        "📖",
        "Patient analyst. Cross-references git history, docs, and runtime behavior to build complete context.",
      ],
      [
        "Tim",
        "Tim",
        "planning",
        "team_leader",
        "claude",
        "📐",
        "Pragmatic architect. Breaks complex problems into small, safe steps. Favors proven patterns over clever solutions.",
      ],
      [
        "Greta",
        "Greta",
        "planning",
        "senior",
        "claude",
        "🗺️",
        "Structured planner. Creates detailed task breakdowns with explicit dependencies and acceptance criteria.",
      ],
      [
        "Mona",
        "Mona",
        "testing",
        "team_leader",
        "claude",
        "🧪",
        "Thorough test engineer. Writes deterministic tests. Covers happy paths, edge cases, and regressions.",
      ],
      [
        "Dieter",
        "Dieter",
        "testing",
        "senior",
        "claude",
        "🔬",
        "Detail-oriented tester. Hunts for edge cases, race conditions, and boundary failures.",
      ],
      [
        "Astrid",
        "Astrid",
        "review",
        "team_leader",
        "claude",
        "🛡️",
        "Rigorous reviewer. Checks security, performance, and plan compliance. Doesn't rubber-stamp.",
      ],
      [
        "Ingrid",
        "Ingrid",
        "design",
        "team_leader",
        "claude",
        "🎨",
        "Design lead. Translates requirements into coherent UI proposals, justifies visual decisions, and provides implementation-ready handoff notes.",
      ],
      [
        "Nele",
        "Nele",
        "qa",
        "team_leader",
        "claude",
        "🦅",
        "Quality lead. Validates expected vs actual behavior, documents reproducible findings with severity, ensures test coverage, and reviews security posture.",
      ],
    ];

    let added = 0;
    for (const [name, nameKo, dept, role, provider, emoji, personality] of newAgents) {
      if (!existingNames.has(name)) {
        if (!existingDeptIds.has(dept)) {
          log.warn({ name, dept }, "skip adding agent: missing department");
          continue;
        }
        try {
          insertAgentIfMissing.run(randomUUID(), name, nameKo, dept, role, provider, emoji, personality);
          added++;
        } catch (err) {
          log.warn({ err, name }, "skip adding agent");
        }
      }
    }
    if (added > 0) log.info({ added }, "added new agents");
  }
}
