#!/usr/bin/env node

/**
 * IronCrew setup script
 *
 * Prepends CEO directive + orchestration rules to the user's AGENTS.md.
 * This is an UPDATE, not an OVERWRITE — existing content is preserved.
 *
 * Usage:
 *   node scripts/setup.mjs [--agents-path /path/to/AGENTS.md] [--port 8790]
 *   pnpm run setup [-- --agents-path /path/to/AGENTS.md --port 8790]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "AGENTS-ironcrew.md");
// These markers keep their pre-rename spelling deliberately. They are not
// branding: they are how this script finds the block it wrote into somebody's
// AGENTS.md on a previous run, and that file is on their disk, unchanged, with
// the old words in it. Rename them and the block is no longer found, so setup
// prepends a second copy instead of updating the first — every run adding
// another. `server/modules/routes/ops/setup-status.ts` matches the same string.
// Changing this needs a migration that rewrites existing files, not an edit.
const START_MARKER = "<!-- BEGIN octooffice orchestration rules -->";
const END_MARKER = "<!-- END octooffice orchestration rules -->";

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { agentsPath: null, port: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agents-path" && args[i + 1]) {
      result.agentsPath = path.resolve(args[++i]);
    } else if (args[i] === "--port" && args[i + 1]) {
      result.port = args[++i];
    }
  }
  return result;
}

function detectPort() {
  // 1. CLI arg (handled by caller)
  // 2. .env file in project root
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/^PORT\s*=\s*(\d+)/m);
    if (match) return match[1];
  }
  // 3. Default
  return "8790";
}

function resolveWorkspaceDir() {
  // Try reading workspace from openclaw.json
  const openclawJson = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (fs.existsSync(openclawJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawJson, "utf8"));
      const w = cfg?.agents?.defaults?.workspace?.trim();
      if (w) {
        const resolved = w.replace(/^~/, os.homedir());
        if (fs.existsSync(resolved)) return resolved;
      }
    } catch {
      /* ignore */
    }
  }

  // Check OPENCLAW_PROFILE
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    const profdir = path.join(os.homedir(), ".openclaw", `workspace-${profile}`);
    if (fs.existsSync(profdir)) return profdir;
  }

  return path.join(os.homedir(), ".openclaw", "workspace");
}

function findAgentsPath() {
  const projectAgentsPath = path.join(process.cwd(), "AGENTS.md");
  // Default target: current project root (ironcrew users first).
  // OpenClaw workspace targeting should be explicit via --agents-path.
  return projectAgentsPath;
}

/**
 * Inject (or update) the IronCrew orchestration rules block into an AGENTS.md file.
 *
 * @param {{ port?: string, agentsPath?: string }} options
 * @returns {{ path: string, port: string }}
 */
export function injectAgentsRules({ port, agentsPath } = {}) {
  const resolvedPort = port || detectPort();
  const resolvedPath = agentsPath || findAgentsPath();

  let templateContent = fs.readFileSync(TEMPLATE_PATH, "utf8");
  templateContent = templateContent.replace(/__PORT__/g, resolvedPort);

  console.log(`[IronCrew] Setting up orchestration rules`);
  console.log(`[IronCrew] Target: ${resolvedPath}`);
  console.log(`[IronCrew] Port: ${resolvedPort}`);

  // Read existing content
  let existingContent = "";
  if (fs.existsSync(resolvedPath)) {
    existingContent = fs.readFileSync(resolvedPath, "utf8");
  }

  // Check if already installed — offer update
  if (existingContent.includes(START_MARKER) && existingContent.includes(END_MARKER)) {
    const startIdx = existingContent.indexOf(START_MARKER);
    const endIdx = existingContent.indexOf(END_MARKER) + END_MARKER.length;
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx);
    const newContent = before + templateContent + after;
    fs.writeFileSync(resolvedPath, newContent, "utf8");
    console.log(`[IronCrew] Updated existing orchestration rules in ${resolvedPath}`);
  } else {
    // Prepend template to existing content
    const newContent = templateContent + "\n\n" + existingContent;

    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolvedPath, newContent, "utf8");
    console.log(`[IronCrew] Orchestration rules added to top of ${resolvedPath}`);
    console.log(`[IronCrew] Your existing AGENTS.md content is preserved below.`);
  }

  // Verify markers after write
  const written = fs.readFileSync(resolvedPath, "utf8");
  if (!written.includes(START_MARKER) || !written.includes(END_MARKER)) {
    throw new Error(`[IronCrew] Marker verification failed after writing ${resolvedPath}`);
  }

  console.log(`[IronCrew] Done!`);

  return { path: resolvedPath, port: resolvedPort };
}

function main() {
  const args = parseArgs();
  injectAgentsRules({ port: args.port, agentsPath: args.agentsPath });
}

// Only run main() when executed directly, not when imported
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
