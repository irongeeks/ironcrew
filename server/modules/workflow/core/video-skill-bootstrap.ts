import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
    run: (...args: any[]) => { changes?: number } | void;
  };
};

type InstallableProvider = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "antigravity";

const REMOTION_SKILL_REPO = "remotion-dev/skills";
const REMOTION_SKILL_ID = "remotion-best-practices";
const REMOTION_SKILL_LABEL = `${REMOTION_SKILL_REPO}#${REMOTION_SKILL_ID}`;
const VIDEO_PREPROD_PACK_KEY = "video_preprod";
const SKILL_AUTO_INSTALL_TIMEOUT_MS = 120_000;
const SKILL_AUTO_INSTALL_FAIL_COOLDOWN_MS = 5 * 60_000;
const SKILLS_NPX_CMD = process.platform === "win32" ? "npx.cmd" : "npx";

const INSTALL_AGENT_BY_PROVIDER: Record<InstallableProvider, string> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  opencode: "opencode",
  copilot: "github-copilot",
  antigravity: "antigravity",
};

const installFailCooldownUntilByProvider = new Map<string, number>();

function normalizeProvider(provider: string | null | undefined): string {
  return String(provider ?? "")
    .trim()
    .toLowerCase();
}

function isInstallableProvider(provider: string): provider is InstallableProvider {
  return (
    provider === "claude" ||
    provider === "codex" ||
    provider === "gemini" ||
    provider === "opencode" ||
    provider === "copilot" ||
    provider === "antigravity"
  );
}

function trimOutput(value: string, max = 400): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function extractExecErrorOutput(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const anyErr = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
  const stdout = anyErr.stdout ? String(anyErr.stdout) : "";
  const stderr = anyErr.stderr ? String(anyErr.stderr) : "";
  const body = `${stderr}\n${stdout}`.trim();
  return body || anyErr.message || String(err);
}

function hasSucceededSkillHistory(db: DbLike, provider: string): boolean {
  try {
    const row = db
      .prepare(
        `
          SELECT 1
          FROM skill_learning_history
          WHERE provider = ?
            AND repo = ?
            AND skill_id = ?
            AND status = 'succeeded'
          LIMIT 1
        `,
      )
      .get(provider, REMOTION_SKILL_REPO, REMOTION_SKILL_ID);
    return !!row;
  } catch {
    return false;
  }
}

function recordSkillHistory(
  db: DbLike,
  nowMs: () => number,
  provider: string,
  status: "succeeded" | "failed",
  command: string,
  startedAt: number,
  completedAt: number,
  errorText: string | null,
): void {
  try {
    const now = nowMs();
    db.prepare(
      `
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
      `,
    ).run(
      randomUUID(),
      `auto-video-skill-bootstrap-${randomUUID()}`,
      provider,
      REMOTION_SKILL_REPO,
      REMOTION_SKILL_ID,
      REMOTION_SKILL_LABEL,
      status,
      command,
      errorText,
      startedAt,
      completedAt,
      now,
      now,
    );
  } catch {
    // Ignore write errors in older schemas/tests. Runtime execution should continue.
  }
}

type EnsureRemotionSkillArgs = {
  db: DbLike;
  nowMs: () => number;
  workflowPackKey: string | null | undefined;
  provider: string | null | undefined;
  taskId?: string | null;
  appendTaskLog?: (taskId: string, kind: string, message: string) => void;
};

export type EnsureRemotionSkillResult =
  | { state: "skipped"; reason: string }
  | { state: "already_learned" }
  | { state: "installed"; command: string }
  | { state: "failed"; error: string };

export function ensureVideoPreprodRemotionBestPracticesSkill(args: EnsureRemotionSkillArgs): EnsureRemotionSkillResult {
  const { db, nowMs, workflowPackKey, provider, taskId, appendTaskLog } = args;
  const log = (kind: string, message: string) => {
    if (!taskId || !appendTaskLog) return;
    appendTaskLog(taskId, kind, message);
  };

  if (String(workflowPackKey ?? "").trim() !== VIDEO_PREPROD_PACK_KEY) {
    return { state: "skipped", reason: "not_video_preprod" };
  }

  const providerKey = normalizeProvider(provider);
  if (!isInstallableProvider(providerKey)) {
    return { state: "skipped", reason: "provider_not_installable" };
  }

  if (hasSucceededSkillHistory(db, providerKey)) {
    return { state: "already_learned" };
  }

  const now = nowMs();
  const cooldownUntil = installFailCooldownUntilByProvider.get(providerKey) ?? 0;
  if (cooldownUntil > now) {
    return { state: "skipped", reason: "install_fail_cooldown" };
  }

  const targetAgent = INSTALL_AGENT_BY_PROVIDER[providerKey];
  const commandWithSkill = [
    "--yes",
    "skills@latest",
    "add",
    REMOTION_SKILL_REPO,
    "--yes",
    "--agent",
    targetAgent,
    "--skill",
    REMOTION_SKILL_ID,
  ];
  const commandFallback = ["--yes", "skills@latest", "add", REMOTION_SKILL_REPO, "--yes", "--agent", targetAgent];
  const commands = [commandWithSkill, commandFallback];

  let lastError = "";
  for (const cmdArgs of commands) {
    const startedAt = nowMs();
    const commandText = `${SKILLS_NPX_CMD} ${cmdArgs.join(" ")}`;
    try {
      execFileSync(SKILLS_NPX_CMD, cmdArgs, {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SKILL_AUTO_INSTALL_TIMEOUT_MS,
      });
      const completedAt = nowMs();
      recordSkillHistory(db, nowMs, providerKey, "succeeded", commandText, startedAt, completedAt, null);
      log("system", `Auto-skill bootstrap: ${REMOTION_SKILL_LABEL} installed for ${providerKey}`);
      return { state: "installed", command: commandText };
    } catch (err) {
      const completedAt = nowMs();
      const out = trimOutput(extractExecErrorOutput(err), 700);
      lastError = out || "unknown_install_error";
      recordSkillHistory(db, nowMs, providerKey, "failed", commandText, startedAt, completedAt, lastError);
    }
  }

  installFailCooldownUntilByProvider.set(providerKey, nowMs() + SKILL_AUTO_INSTALL_FAIL_COOLDOWN_MS);
  log(
    "error",
    `Auto-skill bootstrap failed (${providerKey}, ${REMOTION_SKILL_LABEL}): ${trimOutput(lastError, 240) || "unknown error"}`,
  );
  return { state: "failed", error: lastError || "unknown_install_error" };
}
