import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { E2E_API_PORT, E2E_WEB_PORT, E2E_API_URL, e2eReadyPath } from "../server/config/e2e-isolation.ts";
import { prepareE2ERuntime } from "./prepare-e2e-runtime.mjs";

const require = createRequire(import.meta.url);
const runId = process.env.IRONCREW_E2E_RUN_ID ?? randomBytes(16).toString("hex");
const children: ChildProcess[] = [];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
  const timeout = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }, 3000);
  timeout.unref();
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));

async function assertPortFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`E2E port ${port} is occupied; refusing to reuse any server`)));
    probe.listen(port, "127.0.0.1", () => probe.close((error) => (error ? reject(error) : resolve())));
  });
}

try {
  await assertPortFree(E2E_API_PORT);
  await assertPortFree(E2E_WEB_PORT);
  const { dbPath, logsDir, runtimeDir } = prepareE2ERuntime(runId);
  // Preserve OS/tool discovery, but never inherit deployment configuration,
  // provider credentials, remote runners, or integration destinations.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|Path|HOME|USER|USERNAME|USERPROFILE|SystemRoot|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|XDG_CACHE_HOME|LANG|LC_.*|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CI)$/.test(
        key,
      ),
    ),
  );
  Object.assign(env, {
    IRONCREW_E2E: "1",
    IRONCREW_E2E_RUN_ID: runId,
    VITE_DEV: "1",
    HOST: "127.0.0.1",
    PORT: String(E2E_API_PORT),
    DB_PATH: dbPath,
    LOGS_DIR: logsDir,
    OBSIDIAN_VAULT_PATH: path.join(runtimeDir, "vault"),
    VITE_API_PROXY_TARGET: E2E_API_URL,
    VITE_WS_PROXY_TARGET: E2E_API_URL.replace("http:", "ws:"),
    IRONCREW_SCHEDULER: "off",
    UPDATE_CHECK_ENABLED: "0",
    IRONCREW_INSTALL_TYPE: "source",
    OAUTH_ENCRYPTION_SECRET: randomBytes(32).toString("hex"),
    INBOX_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
  });
  function start(args: string[]) {
    if (stopping) throw new Error("E2E startup cancelled");
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    children.push(child);
    child.once("error", (error) => {
      console.error(error);
      stop(1);
    });
    child.once("exit", () => {
      if (!stopping) stop(1);
    });
    return child;
  }
  start(["--import", "tsx", "server/index.ts"]);
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${E2E_API_URL}${e2eReadyPath(runId)}`, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      if (response.ok) {
        const identity = await response.json();
        if (identity.runId !== runId || identity.dbPath !== dbPath) throw new Error("Unexpected E2E API identity");
        ready = true;
        break;
      }
    } catch {
      /* API is still starting; no frontend is exposed until verified. */
    }
    await delay(200);
  }
  if (!ready) throw new Error("Isolated E2E API did not become ready");
  const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  start([vite, "--host", "127.0.0.1", "--port", String(E2E_WEB_PORT), "--strictPort"]);
  console.log(`[e2e] isolated database: ${dbPath}`);
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : error}`);
  stop(1);
}
