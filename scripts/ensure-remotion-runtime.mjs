#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const RUN_WITH_SHELL = process.platform === "win32";

function isDisabled() {
  const raw = String(process.env.REMOTION_RUNTIME_BOOTSTRAP ?? "1")
    .trim()
    .toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

function runPnpm(args, label) {
  try {
    const output = execFileSync("pnpm", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: RUN_WITH_SHELL,
    });
    return { ok: true, output: output.trim(), label };
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    return {
      ok: false,
      output: `${stdout}\n${stderr}`.trim(),
      label,
    };
  }
}

if (isDisabled()) {
  console.log("[Remotion bootstrap] skipped (REMOTION_RUNTIME_BOOTSTRAP disabled)");
  process.exit(0);
}

const localCli = runPnpm(["exec", "remotion", "--help"], "local_remotion_help");
if (!localCli.ok) {
  console.error("[Remotion bootstrap] failed: local Remotion CLI is not available.");
  if (localCli.output) console.error(localCli.output);
  process.exit(1);
}

const ensureLocal = runPnpm(["exec", "remotion", "browser", "ensure"], "local_browser_ensure");
if (ensureLocal.ok) {
  console.log("[Remotion bootstrap] browser runtime is ready (local CLI).");
  process.exit(0);
}

const ensureFallback = runPnpm(
  ["--package=@remotion/cli", "dlx", "remotion", "browser", "ensure"],
  "fallback_browser_ensure",
);
if (ensureFallback.ok) {
  console.log("[Remotion bootstrap] browser runtime is ready (fallback CLI).");
  process.exit(0);
}

console.error("[Remotion bootstrap] failed: could not ensure Remotion browser runtime.");
if (ensureLocal.output) console.error(ensureLocal.output);
if (ensureFallback.output) console.error(ensureFallback.output);
process.exit(1);
