import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { SkillHistoryProvider, SkillLearnStatus } from "./types.ts";
import { createSkillLearnCore } from "./learn-core.ts";

export function registerSkillLearnRoutes(ctx: RuntimeContext): {
  normalizeSkillLearnProviders: (input: unknown) => string[];
} {
  const { app, db } = ctx;

  const {
    SKILL_LEARN_REPO_RE,
    SKILL_LEARN_HISTORY_RETENTION_DAYS,
    SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT,
    skillLearnJobs,
    normalizeSkillLearnProviders,
    isSkillHistoryProvider,
    normalizeSkillLearnStatus,
    normalizeSkillLearnSkillId,
    pruneSkillLearnJobs,
    pruneSkillLearningHistory,
    createSkillLearnJob,
    runSkillUnlearnForProvider,
  } = createSkillLearnCore(ctx);

  app.post("/api/skills/learn", (req, res) => {
    pruneSkillLearnJobs();
    const repo = String(req.body?.repo ?? "").trim();
    const skillId = String(req.body?.skillId ?? "").trim();
    const providers = normalizeSkillLearnProviders(req.body?.providers);

    if (!repo) {
      return res.status(400).json({ error: "repo required" });
    }
    if (!SKILL_LEARN_REPO_RE.test(repo)) {
      return res.status(400).json({ error: "invalid repo format" });
    }
    if (providers.length === 0) {
      return res.status(400).json({ error: "providers required" });
    }

    const job = createSkillLearnJob(repo, skillId, providers);
    res.status(202).json({ ok: true, job });
  });

  app.get("/api/skills/learn/:jobId", (req, res) => {
    pruneSkillLearnJobs();
    const jobId = String(req.params.jobId ?? "").trim();
    const job = skillLearnJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }
    res.json({ ok: true, job });
  });

  app.get("/api/skills/history", (req, res) => {
    pruneSkillLearningHistory();
    const rawProvider = String(req.query.provider ?? "")
      .trim()
      .toLowerCase();
    const provider = rawProvider ? (isSkillHistoryProvider(rawProvider) ? rawProvider : null) : null;
    if (rawProvider && !provider) {
      return res.status(400).json({ error: "invalid provider" });
    }

    const rawStatus = String(req.query.status ?? "")
      .trim()
      .toLowerCase();
    const status = rawStatus ? normalizeSkillLearnStatus(rawStatus) : null;
    if (rawStatus && !status) {
      return res.status(400).json({ error: "invalid status" });
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT)
      : 50;

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (provider) {
      where.push("provider = ?");
      params.push(provider);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }

    const sql = `
    SELECT
      id,
      job_id,
      provider,
      repo,
      skill_id,
      skill_label,
      status,
      command,
      error,
      run_started_at,
      run_completed_at,
      created_at,
      updated_at
    FROM skill_learning_history
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `;
    params.push(limit);

    const history = db.prepare(sql).all(...params) as Array<{
      id: string;
      job_id: string;
      provider: SkillHistoryProvider;
      repo: string;
      skill_id: string;
      skill_label: string;
      status: SkillLearnStatus;
      command: string;
      error: string | null;
      run_started_at: number | null;
      run_completed_at: number | null;
      created_at: number;
      updated_at: number;
    }>;

    res.json({
      ok: true,
      retention_days: SKILL_LEARN_HISTORY_RETENTION_DAYS,
      history,
    });
  });

  app.get("/api/skills/available", (req, res) => {
    pruneSkillLearningHistory();
    const rawProvider = String(req.query.provider ?? "")
      .trim()
      .toLowerCase();
    const provider = rawProvider ? (isSkillHistoryProvider(rawProvider) ? rawProvider : null) : null;
    if (rawProvider && !provider) {
      return res.status(400).json({ error: "invalid provider" });
    }

    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT)
      : 30;

    const params: Array<string | number> = [];
    let whereClause = "status = 'succeeded'";
    if (provider) {
      whereClause += " AND provider = ?";
      params.push(provider);
    }
    params.push(limit);

    const skills = db
      .prepare(
        `
    SELECT
      provider,
      repo,
      skill_id,
      skill_label,
      MAX(COALESCE(run_completed_at, updated_at, created_at)) AS learned_at
    FROM skill_learning_history
    WHERE ${whereClause}
    GROUP BY provider, repo, skill_id, skill_label
    ORDER BY learned_at DESC
    LIMIT ?
  `,
      )
      .all(...params) as Array<{
      provider: SkillHistoryProvider;
      repo: string;
      skill_id: string;
      skill_label: string;
      learned_at: number;
    }>;

    res.json({ ok: true, skills });
  });

  app.post("/api/skills/unlearn", async (req, res) => {
    pruneSkillLearningHistory();
    const rawProvider = String(req.body?.provider ?? "")
      .trim()
      .toLowerCase();
    const provider = isSkillHistoryProvider(rawProvider) ? rawProvider : null;
    if (!provider) {
      return res.status(400).json({ error: "invalid provider" });
    }

    const repo = String(req.body?.repo ?? "").trim();
    if (!repo || !SKILL_LEARN_REPO_RE.test(repo)) {
      return res.status(400).json({ error: "invalid repo format" });
    }

    const inputSkillId = String(req.body?.skillId ?? req.body?.skill_id ?? "").trim();
    const skillId = normalizeSkillLearnSkillId(inputSkillId, repo);
    const cliResult = await runSkillUnlearnForProvider(provider, repo, skillId);
    if (!cliResult.ok) {
      return res.status(409).json({
        error: cliResult.message || "cli_unlearn_failed",
        code: "cli_unlearn_failed",
        provider,
        repo,
        skill_id: skillId,
        agent: cliResult.agent,
        attempts: cliResult.attempts,
      });
    }

    const removed = db
      .prepare(
        `
    DELETE FROM skill_learning_history
    WHERE provider = ?
      AND repo = ?
      AND skill_id = ?
      AND status = 'succeeded'
  `,
      )
      .run(provider, repo, skillId).changes;

    res.json({
      ok: true,
      provider,
      repo,
      skill_id: skillId,
      removed,
      cli: {
        skipped: cliResult.skipped,
        agent: cliResult.agent,
        skill: cliResult.removedSkill,
        message: cliResult.message,
      },
    });
  });

  return { normalizeSkillLearnProviders };
}
