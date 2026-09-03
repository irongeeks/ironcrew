#!/usr/bin/env node

/**
 * OctoOffice Interactive Setup Wizard
 *
 * Guides the user through first-time configuration:
 *   - Company name & CEO name
 *   - Default CLI provider
 *   - API port
 *   - .env secrets generation
 *   - AGENTS.md orchestration rules injection
 *
 * Usage:
 *   node scripts/setup-wizard.mjs [--port PORT] [--yes]
 *   pnpm run setup:wizard [-- --port PORT --yes]
 *
 * Non-interactive mode: when stdin is not a TTY (piped/redirected), or when
 * --yes / -y is passed, all defaults are accepted without prompting.
 *
 * Zero external dependencies — uses Node.js built-ins only.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { readEnvFile, readEnvValue, upsertEnvValue, generateSecret, writeEnvFile } from "./lib/env-utils.mjs";
import { injectAgentsRules } from "./setup.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example");
const SETUP_JSON_PATH = path.join(ROOT, "setup.json");

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  reset: "\x1b[0m",
};

function info(msg) {
  console.log(`  ${C.green("✓")} ${msg}`);
}

function warn(msg) {
  console.log(`  ${C.yellow("!")} ${msg}`);
}

function err(msg) {
  console.error(`  ${C.red("✗")} ${msg}`);
}

function header(msg) {
  console.log(`\n${C.bold(msg)}`);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { port: null, yes: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      result.port = args[++i];
    } else if (args[i] === "--yes" || args[i] === "-y") {
      result.yes = true;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) {
    err(`Node.js >= 22 is required (found ${process.versions.node})`);
    process.exit(1);
  }
  info(`Node.js ${process.versions.node}`);
}

function checkWritePermission(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    info(`Write permission OK for ${dir}`);
    return true;
  } catch {
    err(`No write permission for ${dir}`);
    return false;
  }
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(parseInt(port, 10), "127.0.0.1");
  });
}

async function runPreflightChecks() {
  header("Pre-flight checks");

  checkNodeVersion();

  const rootWritable = checkWritePermission(ROOT);
  if (!rootWritable) {
    err("Cannot write to project root. Aborting.");
    process.exit(1);
  }

  for (const port of ["8790", "8800"]) {
    const available = await checkPortAvailable(port);
    if (available) {
      info(`Port ${port} is available`);
    } else {
      warn(`Port ${port} appears to be in use — you may need to stop the existing server`);
    }
  }
}

// ---------------------------------------------------------------------------
// readline helper
// ---------------------------------------------------------------------------

function createRL() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ---------------------------------------------------------------------------
// Interactive questions
// ---------------------------------------------------------------------------

const CLI_PROVIDERS = [
  { label: "Claude (recommended)", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Gemini", value: "gemini" },
  { label: "OpenClaw", value: "openclaw" },
  { label: "OpenCode", value: "opencode" },
  { label: "Copilot", value: "copilot" },
  { label: "Antigravity", value: "antigravity" },
];

async function askQuestions(rl, cliArgs) {
  header("Configuration");

  // 1. Company name
  const companyName = (await ask(rl, `  Company name [OctoOffice]: `)) || "OctoOffice";

  // 2. CEO name
  const ceoName = (await ask(rl, `  CEO name [CEO]: `)) || "CEO";

  // 3. Default CLI provider
  console.log("\n  Default CLI provider:");
  CLI_PROVIDERS.forEach((p, i) => {
    console.log(`    ${C.yellow(String(i + 1))}) ${p.label}`);
  });
  let providerChoice = await ask(rl, `  Choose [1]: `);
  if (!providerChoice) providerChoice = "1";
  const providerIdx = parseInt(providerChoice, 10) - 1;
  const defaultProvider =
    providerIdx >= 0 && providerIdx < CLI_PROVIDERS.length ? CLI_PROVIDERS[providerIdx].value : CLI_PROVIDERS[0].value;

  // 4. Port — only ask if not passed via --port
  let port = cliArgs.port;
  if (!port) {
    const portAnswer = await ask(rl, `\n  API port [8790]: `);
    port = portAnswer || "8790";
  } else {
    info(`Port: ${port} (from --port flag)`);
  }

  return { companyName, ceoName, defaultProvider, port };
}

// ---------------------------------------------------------------------------
// .env management
// ---------------------------------------------------------------------------

function ensureEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      info("Created .env from .env.example");
    } else {
      writeEnvFile(ENV_PATH, "");
      info("Created empty .env");
    }
  } else {
    info(".env already exists");
  }
}

function needsSecret(value) {
  return !value || value === "__CHANGE_ME__";
}

function ensureSecrets() {
  let content = readEnvFile(ENV_PATH);

  let changed = false;

  const oauthSecret = readEnvValue(content, "OAUTH_ENCRYPTION_SECRET");
  if (needsSecret(oauthSecret)) {
    content = upsertEnvValue(content, "OAUTH_ENCRYPTION_SECRET", `"${generateSecret()}"`);
    changed = true;
    info("Generated OAUTH_ENCRYPTION_SECRET");
  } else {
    info("OAUTH_ENCRYPTION_SECRET already set");
  }

  const inboxSecret = readEnvValue(content, "INBOX_WEBHOOK_SECRET");
  if (needsSecret(inboxSecret)) {
    content = upsertEnvValue(content, "INBOX_WEBHOOK_SECRET", generateSecret());
    changed = true;
    info("Generated INBOX_WEBHOOK_SECRET");
  } else {
    info("INBOX_WEBHOOK_SECRET already set");
  }

  if (changed) {
    writeEnvFile(ENV_PATH, content);
  }
}

function verifySecrets() {
  const content = readEnvFile(ENV_PATH);
  const oauth = readEnvValue(content, "OAUTH_ENCRYPTION_SECRET");
  const inbox = readEnvValue(content, "INBOX_WEBHOOK_SECRET");

  if (needsSecret(oauth)) {
    err("OAUTH_ENCRYPTION_SECRET is still unset after write — please check .env manually");
    return false;
  }
  if (needsSecret(inbox)) {
    err("INBOX_WEBHOOK_SECRET is still unset after write — please check .env manually");
    return false;
  }
  info("Secret verification passed");
  return true;
}

// ---------------------------------------------------------------------------
// setup.json
// ---------------------------------------------------------------------------

function writeSetupJson({ companyName, ceoName, defaultProvider }) {
  const data = {
    company_name: companyName,
    ceo_name: ceoName,
    default_provider: defaultProvider,
    setup_version: "2.5.0",
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(SETUP_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  info(`Wrote setup.json`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(C.bold("\n╔══════════════════════════════════════╗"));
  console.log(C.bold("║   OctoOffice Interactive Setup     ║"));
  console.log(C.bold("╚══════════════════════════════════════╝"));

  const cliArgs = parseArgs();

  await runPreflightChecks();

  // Non-interactive mode: piped stdin or explicit --yes flag → use defaults
  // without prompting. readline.question() does not fire its callback after
  // stdin EOF, so prompting in a non-TTY context would hang silently.
  const interactive = Boolean(process.stdin.isTTY) && !cliArgs.yes;

  let config;
  if (interactive) {
    const rl = createRL();
    try {
      config = await askQuestions(rl, cliArgs);
    } finally {
      rl.close();
    }
  } else {
    header("Configuration");
    info(cliArgs.yes ? "--yes flag set — accepting defaults" : "Non-interactive stdin — accepting defaults");
    config = {
      companyName: "OctoOffice",
      ceoName: "CEO",
      defaultProvider: CLI_PROVIDERS[0].value,
      port: cliArgs.port || "8790",
    };
    info(`Company: ${config.companyName}`);
    info(`CEO: ${config.ceoName}`);
    info(`Default provider: ${config.defaultProvider}`);
    info(`Port: ${config.port}`);
  }

  const { companyName, ceoName, defaultProvider, port } = config;

  header("Environment");
  ensureEnvFile();
  ensureSecrets();
  if (!verifySecrets()) {
    process.exit(1);
  }

  header("Project config");
  writeSetupJson({ companyName, ceoName, defaultProvider });

  header("AGENTS.md rules");
  try {
    const result = injectAgentsRules({ port });
    info(`Rules injected → ${result.path} (port ${result.port})`);
  } catch (e) {
    err(`Failed to inject AGENTS.md rules: ${e.message}`);
    process.exit(1);
  }

  console.log(`\n${C.green(C.bold("Setup complete!"))} Start with: ${C.yellow("pnpm dev:local")}\n`);
}

main().catch((e) => {
  err(`Unexpected error: ${e.message}`);
  process.exit(1);
});
