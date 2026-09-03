/**
 * WebSocket-based PTY bridge for CLI auth commands.
 *
 * Uses node-pty to spawn the CLI inside a real pseudo-terminal, then
 * bridges I/O over WebSocket so the frontend can embed xterm.js.
 *
 * Protocol:
 *   Client → Server (text):  raw terminal input (keystrokes)
 *   Server → Client (text):  raw terminal output
 *   Client → Server (JSON):  { type: "resize", cols: N, rows: N }
 *   Server → Client (JSON):  { type: "exit", code: N }
 */

import type { WebSocket } from "ws";
import { createRequire } from "node:module";

// node-pty is a native module — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);

/**
 * Deny-list of env var name patterns that must NOT be forwarded to the
 * interactive PTY shell. These are server-side secrets that the CLI being
 * authenticated has no business seeing — keeping them out prevents accidental
 * leakage via `env`, subprocess spawning, or shell history.
 */
const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /^OAUTH_ENCRYPTION_SECRET$/,
  /^SESSION_SECRET$/,
  /^INBOX_WEBHOOK_SECRET$/,
  /^API_AUTH_TOKEN$/,
  /^OAUTH_.*_CLIENT_SECRET$/,
  /^OAUTH_.*_CLIENT_ID$/,
  /^ACCESS_PASSWORD.*$/,
  /^TELEGRAM_BOT_TOKEN$/,
  /^DISCORD_BOT_TOKEN$/,
];

function buildFilteredEnv(): Record<string, string> {
  const src = process.env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERNS.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

const PROVIDER_COMMANDS: Record<string, string[]> = {
  // "claude" (no subcommand) runs the interactive setup wizard which handles
  // auth inline — the user can select theme and paste the code directly in the terminal.
  // "claude auth login" only does an HTTP callback and doesn't prompt for input.
  claude: ["claude"],
  codex: ["codex", "auth", "login"],
  gemini: ["gemini", "auth", "login"],
};

export function handleCliAuthPtyConnection(ws: WebSocket, provider: string): void {
  const args = PROVIDER_COMMANDS[provider];
  if (!args) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown provider: ${provider}` }));
    ws.close();
    return;
  }

  let pty: any;
  try {
    pty = require("node-pty");
  } catch {
    ws.send("\x1b[31mError: node-pty not available. Run `pnpm install` to build native dependencies.\x1b[0m\r\n");
    ws.close();
    return;
  }

  let shell: any;
  try {
    shell = pty.spawn(args[0], args.slice(1), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: buildFilteredEnv(),
    });
  } catch (err: any) {
    ws.send(`\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }

  // PTY output → WebSocket
  shell.onData((data: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close();
    }
  });

  // WebSocket → PTY
  ws.on("message", (data) => {
    const msg = data.toString();

    // Check for JSON control messages
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        shell.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — raw terminal input
    }

    shell.write(msg);
  });

  ws.on("close", () => {
    shell.kill();
  });

  ws.on("error", () => {
    shell.kill();
  });
}
