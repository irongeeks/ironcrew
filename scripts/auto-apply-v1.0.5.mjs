#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEnvFile, readEnvValue, upsertEnvValue, generateSecret } from "./lib/env-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, ".env.example");
const SETUP_SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "setup.mjs");
const MIGRATION_DONE_KEY = "CLAW_MIGRATION_V1_0_5_DONE";
// Pre-rename spelling on purpose — see the note in scripts/setup.mjs. These
// identify a block already written into users' AGENTS.md files.
const START_MARKER = "<!-- BEGIN octooffice orchestration rules -->";
const END_MARKER = "<!-- END octooffice orchestration rules -->";
const REQUIRED_AGENTS_SECRET_TOKEN = "INBOX_SECRET_DISCOVERY_V2";
const REQUIRED_AGENTS_ADDITIONAL_TOKENS = ["TASTE_SKILL_DEFAULT_V1", "WORKFLOW_ORCHESTRATION_BASELINE_V1"];
const MEETING_PROMPT_ENV_DEFAULTS = [
  ["MEETING_PROMPT_TASK_CONTEXT_MAX_CHARS", "1200"],
  ["MEETING_TRANSCRIPT_MAX_TURNS", "20"],
  ["MEETING_TRANSCRIPT_LINE_MAX_CHARS", "180"],
  ["MEETING_TRANSCRIPT_TOTAL_MAX_CHARS", "2400"],
  ["REVIEW_MEETING_ONESHOT_TIMEOUT_MS", "65000"],
];

function stripOuterQuotes(raw) {
  return (raw ?? "").trim().replace(/^['\"]|['\"]$/g, "");
}

function normalizeSecret(raw) {
  const normalized = stripOuterQuotes(raw);
  if (!normalized || normalized === "__CHANGE_ME__") return "";
  return normalized;
}

function normalizePathEnv(raw) {
  const normalized = stripOuterQuotes(raw);
  if (!normalized || normalized === "__CHANGE_ME__") return "";
  if (!normalized.startsWith("~")) return normalized.replace(/\\/g, "/");

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) return normalized.replace(/\\/g, "/");

  const suffix = normalized.slice(1).replace(/^[\\/]+/, "");
  const resolved = suffix ? path.resolve(home, suffix) : home;
  return resolved.replace(/\\/g, "/");
}

function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) return;
  if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    console.log("[IronCrew] v1.0.5 auto-apply: created .env from .env.example");
    return;
  }
  fs.writeFileSync(ENV_PATH, "", "utf8");
  console.log("[IronCrew] v1.0.5 auto-apply: created empty .env");
}

function resolvePort(content) {
  const fromProcess = process.env.PORT?.trim();
  if (fromProcess) return fromProcess;

  const raw = stripOuterQuotes(readEnvValue(content, "PORT"));
  if (/^\d+$/.test(raw)) return raw;

  return "8790";
}

function ensureMeetingPromptEnvDefaults(content, changes) {
  let patched = false;

  for (const [key, defaultValue] of MEETING_PROMPT_ENV_DEFAULTS) {
    const current = stripOuterQuotes(readEnvValue(content, key));
    if (current) continue;
    content = upsertEnvValue(content, key, defaultValue);
    changes.push(`set ${key}=${defaultValue}`);
    patched = true;
  }

  return { content, patched };
}

function maybeAutoPatchEnv() {
  ensureEnvFile();

  let content = fs.readFileSync(ENV_PATH, "utf8");
  const changes = [];
  const migrationDone = stripOuterQuotes(readEnvValue(content, MIGRATION_DONE_KEY)) === "1";

  const inboxSecret = normalizeSecret(readEnvValue(content, "INBOX_WEBHOOK_SECRET"));
  const needsInboxSecret = !inboxSecret;
  const rawOpenClawConfig = readEnvValue(content, "OPENCLAW_CONFIG");
  const normalizedOpenClawConfig = normalizePathEnv(rawOpenClawConfig);
  let needsOpenClawPatch = false;

  if (!normalizedOpenClawConfig) {
    const autoDetected = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (fs.existsSync(autoDetected)) {
      needsOpenClawPatch = true;
      const normalized = autoDetected.replace(/\\/g, "/");
      content = upsertEnvValue(content, "OPENCLAW_CONFIG", normalized);
      changes.push("set OPENCLAW_CONFIG from ~/.openclaw/openclaw.json");
    }
  } else if (rawOpenClawConfig !== normalizedOpenClawConfig) {
    needsOpenClawPatch = true;
    content = upsertEnvValue(content, "OPENCLAW_CONFIG", normalizedOpenClawConfig);
    changes.push("normalized OPENCLAW_CONFIG path");
  }

  const meetingEnvPatch = ensureMeetingPromptEnvDefaults(content, changes);
  content = meetingEnvPatch.content;
  const needsMeetingPromptEnvPatch = meetingEnvPatch.patched;

  const needsAgentsRefresh = shouldRefreshAgentsRules();
  const needsMigration = needsInboxSecret || needsOpenClawPatch || needsMeetingPromptEnvPatch || needsAgentsRefresh;

  if (migrationDone && !needsMigration) {
    return {
      content,
      needsMigration: false,
      needsAgentsRefresh: false,
      skippedByMarker: true,
    };
  }

  if (!needsMigration) {
    return {
      content,
      needsMigration: false,
      needsAgentsRefresh: false,
      skippedByMarker: false,
    };
  }

  if (needsInboxSecret) {
    const generated = generateSecret();
    content = upsertEnvValue(content, "INBOX_WEBHOOK_SECRET", generated);
    changes.push("generated INBOX_WEBHOOK_SECRET");
  }

  fs.writeFileSync(ENV_PATH, content, "utf8");
  if (changes.length > 0) {
    console.log(`[IronCrew] v1.0.5 auto-apply: ${changes.join(", ")}`);
  }

  return {
    content,
    needsMigration: true,
    needsAgentsRefresh,
    skippedByMarker: false,
  };
}

function resolveWorkspaceDir() {
  const openclawJson = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (fs.existsSync(openclawJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawJson, "utf8"));
      const workspace = cfg?.agents?.defaults?.workspace?.trim();
      if (workspace) {
        const resolved = workspace.replace(/^~/, os.homedir());
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch {
      // ignore malformed openclaw config
    }
  }

  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    const profileDir = path.join(os.homedir(), ".openclaw", `workspace-${profile}`);
    if (fs.existsSync(profileDir)) return profileDir;
  }

  return path.join(os.homedir(), ".openclaw", "workspace");
}

function resolveAgentsPath() {
  const projectAgentsPath = path.join(ROOT_DIR, "AGENTS.md");
  // Default target for migration: project-local AGENTS.md (ironcrew users first).
  // OpenClaw workspace targeting should be explicit via setup --agents-path.
  return projectAgentsPath;
}

function shouldRefreshAgentsRules() {
  const agentsPath = resolveAgentsPath();
  if (!fs.existsSync(agentsPath)) return true;

  const content = fs.readFileSync(agentsPath, "utf8");
  if (!content.includes(START_MARKER) || !content.includes(END_MARKER)) return true;
  if (!content.includes("x-inbox-secret")) return true;
  if (!content.includes(REQUIRED_AGENTS_SECRET_TOKEN)) return true;
  for (const token of REQUIRED_AGENTS_ADDITIONAL_TOKENS) {
    if (!content.includes(token)) return true;
  }
  return false;
}

function refreshAgentsRules(port) {
  if (!fs.existsSync(SETUP_SCRIPT_PATH)) {
    console.warn("[IronCrew] v1.0.5 auto-apply: scripts/setup.mjs not found; skipped AGENTS update");
    return false;
  }

  const result = spawnSync(process.execPath, [SETUP_SCRIPT_PATH, "--port", port], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
  });

  if (typeof result.status === "number" && result.status === 0) {
    return true;
  }

  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  const reason = stderr || stdout || result.error?.message || "unknown error";
  console.warn(`[IronCrew] v1.0.5 auto-apply: AGENTS update skipped (${reason})`);
  return false;
}

function markMigrationDone(content) {
  if (stripOuterQuotes(readEnvValue(content, MIGRATION_DONE_KEY)) === "1") return;
  const updated = upsertEnvValue(content, MIGRATION_DONE_KEY, "1");
  fs.writeFileSync(ENV_PATH, updated, "utf8");
  console.log("[IronCrew] v1.0.5 auto-apply: migration marked complete");
}

function main() {
  try {
    const migration = maybeAutoPatchEnv();
    if (migration.skippedByMarker) return;
    if (!migration.needsMigration) {
      markMigrationDone(migration.content);
      return;
    }

    const envContent = migration.content;
    if (migration.needsAgentsRefresh) {
      const port = resolvePort(envContent);
      const applied = refreshAgentsRules(port);
      if (!applied) return;
    }

    markMigrationDone(envContent);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[IronCrew] v1.0.5 auto-apply: non-blocking failure (${msg})`);
  }
}

main();
