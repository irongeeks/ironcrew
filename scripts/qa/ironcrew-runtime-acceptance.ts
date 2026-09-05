/** Explicit operator-run acceptance; default is local version/help/auth checks only. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claudeAdapter } from "../../server/adapters/claude.ts";
import { codexAdapter } from "../../server/adapters/codex.ts";
import { antigravityAdapter } from "../../server/adapters/antigravity.ts";
import { geminiAdapter } from "../../server/adapters/gemini.ts";
import { CliAdapterRuntime } from "../../server/ironcrew/runtime/cli-adapter-runtime.ts";
import type { RunContext, RunEvent } from "../../server/ironcrew/runtime/run-events.ts";

const argv = process.argv.slice(2);
const allowed = new Set(["--provider", "--workspace", "--execute"]);
for (let i = 0; i < argv.length; i++) {
  if (!allowed.has(argv[i])) throw new Error("Unknown argument. See docs/CLI_RUNTIME_ACCEPTANCE.md.");
  if (argv[i] !== "--execute") i++;
}
const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const provider = value("--provider");
const workspace = value("--workspace");
const adapter = [claudeAdapter, codexAdapter, antigravityAdapter, geminiAdapter].find(
  (item) => item.providerType === provider,
);
if (!adapter || !workspace || !path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) {
  throw new Error("Provide --provider claude|codex|antigravity|gemini and --workspace /existing/disposable-project.");
}
const runtime = new CliAdapterRuntime(adapter);
const capabilities = await runtime.capabilities();
const health = await runtime.healthCheck();
const auth = await runtime.authStatus();
console.log(JSON.stringify({ provider, capabilities, health, auth }));
if (argv.includes("--execute")) {
  if (!health.healthy || !capabilities.sessionResume)
    throw new Error("Installed CLI has not confirmed start/resume support.");
  const marker = `IRONCREW_${randomUUID().replaceAll("-", "")}`;
  const context: RunContext = {
    companyId: "acceptance",
    taskId: "acceptance",
    projectId: null,
    runId: randomUUID(),
    agentId: null,
    correlationId: randomUUID(),
    workspacePath: fs.realpathSync(workspace),
    permissionMode: "restricted",
    sensitive: true,
  };
  const consume = async (stream: AsyncIterable<RunEvent>) => {
    let text = "";
    let sessionRef: string | undefined;
    let completed = false;
    for await (const event of stream) {
      console.log(JSON.stringify({ event: event.type, runId: event.runId }));
      if (typeof event.payload.sessionRef === "string") sessionRef = event.payload.sessionRef;
      if (event.type === "message.completed") text = String(event.payload.text ?? "");
      if (event.type === "run.completed") completed = true;
    }
    return { text, sessionRef, completed };
  };
  const first = await consume(
    runtime.startRun(
      { prompt: `Do not use any tools. Remember this marker for my next message and repeat it exactly: ${marker}` },
      context,
    ),
  );
  if (!first.completed || !first.sessionRef || !first.text.includes(marker))
    throw new Error("Initial CLI acceptance failed. Inspect the local CLI; no response content is printed.");
  const resumed = await consume(
    runtime.resumeRun(
      first.sessionRef,
      { prompt: "Do not use any tools. Repeat only the marker I asked you to remember." },
      { ...context, runId: randomUUID() },
    ),
  );
  if (!resumed.completed || !resumed.text.includes(marker)) throw new Error("Session resume acceptance failed.");
  console.log(JSON.stringify({ acceptance: "passed", provider, start: true, resume: true }));
}
