import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { SkillHistoryProvider, SkillLearnJob, SkillLearnProvider, SkillLearnStatus } from "./types.ts";
import {
  SKILL_HISTORY_PROVIDER_TO_AGENT,
  SKILL_LEARN_HISTORY_MAX_QUERY_LIMIT,
  SKILL_LEARN_HISTORY_RETENTION_DAYS,
  SKILL_LEARN_MAX_LOG_LINES,
  SKILL_LEARN_PROVIDER_TO_AGENT,
  SKILL_LEARN_REPO_RE,
  isSkillHistoryProvider,
  isSkillLearnProvider,
  SKILL_LEARN_JOB_TTL_MS,
  SKILL_LEARN_MAX_JOBS,
  SKILL_LEARN_HISTORY_RETENTION_MS,
  SKILL_LEARN_HISTORY_MAX_ROWS_PER_PROVIDER,
  SKILL_UNLEARN_TIMEOUT_MS,
  SKILLS_NPX_CMD,
} from "./learn-constants.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "ops" });

type SkillLinkState = "linked" | "not_linked" | "unverifiable";

type SkillUnlearnResult = {
  ok: boolean;
  skipped: boolean;
  agent: string | null;
  removedSkill: string | null;
  message: string;
  attempts: Array<{ skill: string; output: string }>;
};

function normalizeSkillLearnProviders(input: unknown): SkillLearnProvider[] {
  if (!Array.isArray(input)) return [];
  const out: SkillLearnProvider[] = [];
  for (const raw of input) {
    const value = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (isSkillLearnProvider(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function normalizeSkillLearnStatus(input: string): SkillLearnStatus | null {
  if (input === "queued" || input === "running" || input === "succeeded" || input === "failed") {
    return input;
  }
  return null;
}

function normalizeSkillLearnSkillId(skillId: string, repo: string): string {
  const trimmed = skillId.trim();
  if (trimmed) return trimmed;
  const repoTail = repo.split("/").filter(Boolean).pop();
  if (repoTail) return repoTail;
  return "unknown-skill";
}

function stripAnsiControl(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    if (ch === 27 && value[i + 1] === "[") {
      i += 1;
      while (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        i += 1;
        if (next >= 64 && next <= 126) break;
      }
      continue;
    }
    out += value[i] ?? "";
  }
  return out;
}

function buildSkillUnlearnCandidates(skillId: string, repo: string): string[] {
  const out: string[] = [];
  const pushUnique = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };

  pushUnique(skillId);
  if (skillId.includes("#")) {
    const tail = skillId.split("#").filter(Boolean).pop();
    if (tail) pushUnique(tail);
  }
  if (skillId.includes(":")) {
    const tail = skillId.split(":").filter(Boolean).pop();
    if (tail) pushUnique(tail);
  }
  if (skillId.includes("/")) {
    const tail = skillId.split("/").filter(Boolean).pop();
    if (tail) pushUnique(tail);
  }
  const repoTail = repo.split("/").filter(Boolean).pop();
  if (repoTail) pushUnique(repoTail);
  return out;
}

function formatExecError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function buildSkillLearnLabel(repo: string, skillId: string): string {
  if (!skillId) return repo;
  return `${repo}#${skillId}`;
}

function resolveAgentSkillDir(agent: string): string | null {
  if (agent === "claude-code") return path.join(process.cwd(), ".claude", "skills");
  if (agent === "codex") return path.join(process.cwd(), ".codex", "skills");
  if (agent === "gemini-cli") return path.join(process.cwd(), ".gemini", "skills");
  if (agent === "opencode") return path.join(process.cwd(), ".opencode", "skills");
  if (agent === "github-copilot") return path.join(process.cwd(), ".copilot", "skills");
  if (agent === "antigravity") return path.join(process.cwd(), ".antigravity", "skills");
  return null;
}

function detectSkillLinkStateFromFilesystem(agent: string, candidates: string[]): SkillLinkState {
  const agentSkillDir = resolveAgentSkillDir(agent);
  if (!agentSkillDir || !fs.existsSync(agentSkillDir)) {
    return "unverifiable";
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(agentSkillDir, candidate))) {
        return "linked";
      }
    } catch {
      // ignore and continue checks
    }
  }
  return "not_linked";
}

export function createSkillLearnCore(ctx: RuntimeContext) {
  const { db, execWithTimeout } = ctx;
  const skillLearnJobs = new Map<string, SkillLearnJob>();

  function pruneSkillLearnJobs(now = Date.now()): void {
    if (skillLearnJobs.size === 0) return;
    for (const [id, job] of skillLearnJobs.entries()) {
      const end = job.completedAt ?? job.updatedAt;
      const expired = job.status !== "running" && now - end > SKILL_LEARN_JOB_TTL_MS;
      if (expired) skillLearnJobs.delete(id);
    }
    if (skillLearnJobs.size <= SKILL_LEARN_MAX_JOBS) return;
    const oldest = [...skillLearnJobs.values()]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, Math.max(0, skillLearnJobs.size - SKILL_LEARN_MAX_JOBS));
    for (const job of oldest) {
      if (job.status === "running") continue;
      skillLearnJobs.delete(job.id);
    }
  }

  function pruneSkillLearningHistory(now = Date.now()): void {
    db.prepare(
      `
    DELETE FROM skill_learning_history
    WHERE COALESCE(run_completed_at, updated_at, created_at) < ?
  `,
    ).run(now - SKILL_LEARN_HISTORY_RETENTION_MS);

    const overflowProviders = db
      .prepare(
        `
    SELECT provider, COUNT(*) AS cnt
    FROM skill_learning_history
    GROUP BY provider
    HAVING COUNT(*) > ?
  `,
      )
      .all(SKILL_LEARN_HISTORY_MAX_ROWS_PER_PROVIDER) as Array<{ provider: string; cnt: number }>;
    if (overflowProviders.length === 0) return;

    const trimStmt = db.prepare(`
    DELETE FROM skill_learning_history
    WHERE provider = ?
      AND id IN (
        SELECT id
        FROM skill_learning_history
        WHERE provider = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT -1 OFFSET ?
      )
  `);
    for (const row of overflowProviders) {
      trimStmt.run(row.provider, row.provider, SKILL_LEARN_HISTORY_MAX_ROWS_PER_PROVIDER);
    }
  }

  function recordSkillLearnHistoryState(
    job: SkillLearnJob,
    status: SkillLearnStatus,
    opts: {
      error?: string | null;
      startedAt?: number | null;
      completedAt?: number | null;
    } = {},
  ): void {
    const now = Date.now();
    const normalizedSkillId = normalizeSkillLearnSkillId(job.skillId, job.repo);
    const skillLabel = buildSkillLearnLabel(job.repo, normalizedSkillId);
    const upsert = db.prepare(`
    INSERT INTO skill_learning_history (
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
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, provider) DO UPDATE SET
      repo = excluded.repo,
      skill_id = excluded.skill_id,
      skill_label = excluded.skill_label,
      status = excluded.status,
      command = excluded.command,
      error = excluded.error,
      run_started_at = COALESCE(excluded.run_started_at, skill_learning_history.run_started_at),
      run_completed_at = COALESCE(excluded.run_completed_at, skill_learning_history.run_completed_at),
      updated_at = excluded.updated_at
  `);

    for (const provider of job.providers) {
      upsert.run(
        randomUUID(),
        job.id,
        provider,
        job.repo,
        normalizedSkillId,
        skillLabel,
        status,
        job.command,
        opts.error ?? null,
        opts.startedAt ?? null,
        opts.completedAt ?? null,
        now,
        now,
      );
    }
    pruneSkillLearningHistory(now);
  }

  function appendSkillLearnLogs(job: SkillLearnJob, chunk: string): void {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      job.logTail.push(line);
    }
    if (job.logTail.length > SKILL_LEARN_MAX_LOG_LINES) {
      job.logTail.splice(0, job.logTail.length - SKILL_LEARN_MAX_LOG_LINES);
    }
    job.updatedAt = Date.now();
  }

  function createSkillLearnJob(repo: string, skillId: string, providers: SkillLearnProvider[]): SkillLearnJob {
    const id = randomUUID();
    const normalizedSkillId = normalizeSkillLearnSkillId(skillId, repo);
    const agents = providers
      .map((provider) => SKILL_LEARN_PROVIDER_TO_AGENT[provider])
      .filter((value, index, arr) => arr.indexOf(value) === index);
    const args = ["--yes", "skills@latest", "add", repo, "--yes", "--agent", ...agents];
    const job: SkillLearnJob = {
      id,
      repo,
      skillId: normalizedSkillId,
      providers,
      agents,
      status: "queued",
      command: `npx ${args.join(" ")}`,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      updatedAt: Date.now(),
      exitCode: null,
      logTail: [],
      error: null,
    };
    skillLearnJobs.set(id, job);
    try {
      recordSkillLearnHistoryState(job, "queued");
    } catch (err) {
      log.warn({ err }, "failed to record queued history");
    }

    setTimeout(() => {
      job.status = "running";
      job.startedAt = Date.now();
      job.updatedAt = job.startedAt;
      try {
        recordSkillLearnHistoryState(job, "running", { startedAt: job.startedAt });
      } catch (err) {
        log.warn({ err }, "failed to record running history");
      }

      let child;
      try {
        child = spawn(SKILLS_NPX_CMD, args, {
          cwd: process.cwd(),
          env: { ...process.env, FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = Date.now();
        job.updatedAt = job.completedAt;
        appendSkillLearnLogs(job, `ERROR: ${job.error}`);
        try {
          recordSkillLearnHistoryState(job, "failed", {
            error: job.error,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          });
        } catch (historyErr) {
          log.warn({ err: historyErr }, "failed to record spawn error history");
        }
        pruneSkillLearnJobs();
        return;
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        appendSkillLearnLogs(job, String(chunk));
      });
      child.stderr?.on("data", (chunk: string | Buffer) => {
        appendSkillLearnLogs(job, String(chunk));
      });
      child.on("error", (err: Error) => {
        job.status = "failed";
        job.error = err.message || String(err);
        job.completedAt = Date.now();
        job.updatedAt = job.completedAt;
        appendSkillLearnLogs(job, `ERROR: ${job.error}`);
        try {
          recordSkillLearnHistoryState(job, "failed", {
            error: job.error,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          });
        } catch (historyErr) {
          log.warn({ err: historyErr }, "failed to record error history");
        }
        pruneSkillLearnJobs();
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        job.exitCode = code;
        job.completedAt = Date.now();
        job.updatedAt = job.completedAt;
        if (code === 0) {
          job.status = "succeeded";
        } else {
          job.status = "failed";
          job.error = signal ? `process terminated by ${signal}` : `process exited with code ${String(code)}`;
        }
        try {
          recordSkillLearnHistoryState(job, job.status, {
            error: job.error,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          });
        } catch (historyErr) {
          log.warn({ err: historyErr }, "failed to record close history");
        }
        pruneSkillLearnJobs();
      });
    }, 0);

    return job;
  }

  async function runSkillUnlearnForProvider(
    provider: SkillHistoryProvider,
    repo: string,
    skillId: string,
  ): Promise<SkillUnlearnResult> {
    const agent = SKILL_HISTORY_PROVIDER_TO_AGENT[provider] ?? null;
    if (!agent) {
      return {
        ok: true,
        skipped: true,
        agent: null,
        removedSkill: null,
        message: "no_local_cli_agent_for_provider",
        attempts: [],
      };
    }

    const candidates = buildSkillUnlearnCandidates(skillId, repo);
    const attempts: Array<{ skill: string; output: string }> = [];
    const preState = detectSkillLinkStateFromFilesystem(agent, candidates);
    if (preState === "not_linked") {
      return {
        ok: true,
        skipped: true,
        agent,
        removedSkill: null,
        message: "skill_already_unlinked",
        attempts,
      };
    }
    const strictVerify = preState !== "unverifiable";

    let removedSkill: string | null = null;
    let sawNoMatching = true;
    for (const candidate of candidates) {
      const args = ["--yes", "skills@latest", "remove", "--yes", "--agent", agent, "--skill", candidate];
      try {
        const rawOutput = await execWithTimeout(SKILLS_NPX_CMD, args, SKILL_UNLEARN_TIMEOUT_MS);
        const output = stripAnsiControl(rawOutput || "").trim();
        attempts.push({ skill: candidate, output });
        if (/no matching skills found/i.test(output)) {
          continue;
        }
        sawNoMatching = false;
        removedSkill = candidate;
        break;
      } catch (err) {
        return {
          ok: false,
          skipped: false,
          agent,
          removedSkill: null,
          message: formatExecError(err),
          attempts,
        };
      }
    }

    const postState = detectSkillLinkStateFromFilesystem(agent, candidates);
    attempts.push({ skill: "__verify__", output: `state=${postState}` });
    if (strictVerify && postState === "linked") {
      return {
        ok: false,
        skipped: false,
        agent,
        removedSkill: null,
        message: "cli_unlearn_verify_failed_fs_still_linked",
        attempts,
      };
    }

    if (removedSkill) {
      return {
        ok: true,
        skipped: false,
        agent,
        removedSkill,
        message: "cli_skill_remove_ok",
        attempts,
      };
    }

    return {
      ok: true,
      skipped: true,
      agent,
      removedSkill: null,
      message: sawNoMatching
        ? strictVerify
          ? "no_matching_installed_skill_found_for_unlearn"
          : "no_matching_installed_skill_found_unverifiable_scope"
        : "cli_unlearn_unverifiable_scope",
      attempts,
    };
  }

  return {
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
  };
}
