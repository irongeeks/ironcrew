import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { DecryptedOAuthToken } from "./types.ts";
import { createStreamTools } from "./stream-tools.ts";
import { toErrorMessage } from "../../../routes/validation.ts";
import { logger } from "../../../../observability/logger.ts";

const log = logger.child({ module: "workflow-agents" });

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateHttpAgentToolsDeps = {
  db: DbLike;
  logsDir: string;
  activeProcesses: Map<string, ChildProcess>;
  broadcast: (event: string, payload: unknown) => void;
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  createSubtaskFromCli: (taskId: string, cliToolUseId: string, title: string) => void;
  completeSubtaskFromCli: (cliToolUseId: string) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  setActiveOAuthAccount: (provider: string, accountId: string) => void;
  getProviderModelConfig: () => Record<
    string,
    { model: string; subModel?: string; reasoningLevel?: string; subModelReasoningLevel?: string }
  >;
  getOAuthAutoSwapEnabled: () => boolean;
  getPreferredOAuthAccounts: (provider: string, opts?: { includeStandby?: boolean }) => DecryptedOAuthToken[];
  prioritizeOAuthAccount: (
    accounts: DecryptedOAuthToken[],
    preferredAccountId?: string | null,
  ) => DecryptedOAuthToken[];
  rotateOAuthAccounts: (provider: string, accounts: DecryptedOAuthToken[]) => DecryptedOAuthToken[];
  getOAuthAccountDisplayName: (account: DecryptedOAuthToken) => string;
  exchangeCopilotToken: (githubToken: string) => Promise<{ token: string; baseUrl: string; expiresAt: number }>;
  refreshGoogleToken: (credential: DecryptedOAuthToken) => Promise<string>;
  loadCodeAssistProject: (accessToken: string, signal?: AbortSignal) => Promise<string>;
  markOAuthAccountFailure: (accountId: string, message: string) => void;
  markOAuthAccountSuccess: (accountId: string) => void;
  ANTIGRAVITY_ENDPOINTS: string[];
};

export function createHttpAgentTools(deps: CreateHttpAgentToolsDeps) {
  const {
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
    handleTaskRunComplete,
    setActiveOAuthAccount,
    getProviderModelConfig,
    getOAuthAutoSwapEnabled,
    getPreferredOAuthAccounts,
    prioritizeOAuthAccount,
    rotateOAuthAccounts,
    getOAuthAccountDisplayName,
    exchangeCopilotToken,
    refreshGoogleToken,
    loadCodeAssistProject,
    markOAuthAccountFailure,
    markOAuthAccountSuccess,
    ANTIGRAVITY_ENDPOINTS,
  } = deps;

  const { parseHttpAgentSubtasks, createSafeLogStreamOps, parseSSEStream, parseGeminiSSEStream } = createStreamTools({
    db,
    broadcast,
    normalizeStreamChunk,
    createSubtaskFromCli,
    completeSubtaskFromCli,
  });

  function resolveCopilotModel(rawModel: string): string {
    return rawModel.includes("/") ? rawModel.split("/").pop()! : rawModel;
  }

  function resolveAntigravityModel(rawModel: string): string {
    let model = rawModel;
    if (model.includes("antigravity-")) {
      model = model.slice(model.indexOf("antigravity-") + "antigravity-".length);
    } else if (model.includes("/")) {
      model = model.split("/").pop()!;
    }
    return model;
  }

  async function executeCopilotAgent(
    prompt: string,
    projectPath: string,
    logStream: fs.WriteStream,
    signal: AbortSignal,
    taskId?: string,
    preferredAccountId?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ): Promise<void> {
    const safeWrite = safeWriteOverride ?? createSafeLogStreamOps(logStream).safeWrite;
    const modelConfig = getProviderModelConfig();
    const defaultRawModel = modelConfig.copilot?.model || "github-copilot/gpt-4o";
    const autoSwap = getOAuthAutoSwapEnabled();
    const preferred = getPreferredOAuthAccounts("github").filter((a) => Boolean(a.accessToken));
    const baseAccounts = prioritizeOAuthAccount(preferred, preferredAccountId);
    const hasPinnedAccount = Boolean(preferredAccountId) && baseAccounts.some((a) => a.id === preferredAccountId);
    const accounts = hasPinnedAccount ? baseAccounts : rotateOAuthAccounts("github", baseAccounts);
    if (accounts.length === 0) {
      throw new Error("No GitHub OAuth token found. Connect GitHub Copilot first.");
    }

    const maxAttempts = autoSwap ? accounts.length : Math.min(accounts.length, 1);
    let lastError: Error | null = null;

    for (let i = 0; i < maxAttempts; i += 1) {
      const account = accounts[i];
      if (!account.accessToken) continue;
      const accountName = getOAuthAccountDisplayName(account);
      const rawModel = account.modelOverride || defaultRawModel;
      const model = resolveCopilotModel(rawModel);

      const header = `[copilot] Account: ${accountName}${account.modelOverride ? ` (model override: ${rawModel})` : ""}\n`;
      safeWrite(header);
      if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: header });

      try {
        safeWrite("[copilot] Exchanging Copilot token...\n");
        if (taskId)
          broadcast("cli_output", {
            task_id: taskId,
            stream: "stderr",
            data: "[copilot] Exchanging Copilot token...\n",
          });
        const { token, baseUrl } = await exchangeCopilotToken(account.accessToken);
        safeWrite(`[copilot] Model: ${model}, Base: ${baseUrl}\n---\n`);
        if (taskId)
          broadcast("cli_output", {
            task_id: taskId,
            stream: "stderr",
            data: `[copilot] Model: ${model}, Base: ${baseUrl}\n---\n`,
          });

        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Editor-Version": "octooffice/1.0.0",
            "Copilot-Integration-Id": "vscode-chat",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: `You are a coding assistant. Project path: ${projectPath}` },
              { role: "user", content: prompt },
            ],
            stream: true,
          }),
          signal,
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Copilot API error (${resp.status}): ${text}`);
        }

        await parseSSEStream(resp.body!, signal, safeWrite, taskId);
        markOAuthAccountSuccess(account.id!);
        if (i > 0 && autoSwap && account.id) {
          setActiveOAuthAccount("github", account.id);
          const swapMsg = `[copilot] Promoted account in active pool: ${accountName}\n`;
          safeWrite(swapMsg);
          if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: swapMsg });
        }
        safeWrite(`\n---\n[copilot] Done.\n`);
        if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: "\n---\n[copilot] Done.\n" });
        return;
      } catch (err: unknown) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
        const msg = toErrorMessage(err);
        markOAuthAccountFailure(account.id!, msg);
        const failMsg = `[copilot] Account ${accountName} failed: ${msg}\n`;
        safeWrite(failMsg);
        if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: failMsg });
        lastError = err instanceof Error ? err : new Error(msg);
        if (autoSwap && i + 1 < maxAttempts) {
          const nextName = getOAuthAccountDisplayName(accounts[i + 1]);
          const swapMsg = `[copilot] Trying fallback account: ${nextName}\n`;
          safeWrite(swapMsg);
          if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: swapMsg });
        }
      }
    }

    throw lastError ?? new Error("No runnable GitHub Copilot account available.");
  }

  async function executeAntigravityAgent(
    prompt: string,
    logStream: fs.WriteStream,
    signal: AbortSignal,
    taskId?: string,
    preferredAccountId?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ): Promise<void> {
    const safeWrite = safeWriteOverride ?? createSafeLogStreamOps(logStream).safeWrite;
    const modelConfig = getProviderModelConfig();
    const defaultRawModel = modelConfig.antigravity?.model || "google/antigravity-gemini-2.5-pro";
    const autoSwap = getOAuthAutoSwapEnabled();
    const preferred = getPreferredOAuthAccounts("google_antigravity").filter((a) =>
      Boolean(a.accessToken || a.refreshToken),
    );
    const baseAccounts = prioritizeOAuthAccount(preferred, preferredAccountId);
    const hasPinnedAccount = Boolean(preferredAccountId) && baseAccounts.some((a) => a.id === preferredAccountId);
    const accounts = hasPinnedAccount ? baseAccounts : rotateOAuthAccounts("google_antigravity", baseAccounts);
    if (accounts.length === 0) {
      throw new Error("No Google OAuth token found. Connect Antigravity first.");
    }

    const maxAttempts = autoSwap ? accounts.length : Math.min(accounts.length, 1);
    let lastError: Error | null = null;

    for (let i = 0; i < maxAttempts; i += 1) {
      const account = accounts[i];
      const accountName = getOAuthAccountDisplayName(account);
      const rawModel = account.modelOverride || defaultRawModel;
      const model = resolveAntigravityModel(rawModel);

      const header = `[antigravity] Account: ${accountName}${account.modelOverride ? ` (model override: ${rawModel})` : ""}\n`;
      safeWrite(header);
      if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: header });

      try {
        safeWrite(`[antigravity] Refreshing token...\n`);
        if (taskId)
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: "[antigravity] Refreshing token...\n" });
        const accessToken = await refreshGoogleToken(account);

        safeWrite(`[antigravity] Discovering project...\n`);
        if (taskId)
          broadcast("cli_output", {
            task_id: taskId,
            stream: "stderr",
            data: "[antigravity] Discovering project...\n",
          });
        const projectId = await loadCodeAssistProject(accessToken, signal);
        safeWrite(`[antigravity] Model: ${model}, Project: ${projectId}\n---\n`);
        if (taskId)
          broadcast("cli_output", {
            task_id: taskId,
            stream: "stderr",
            data: `[antigravity] Model: ${model}, Project: ${projectId}\n---\n`,
          });

        const baseEndpoint = ANTIGRAVITY_ENDPOINTS[0];
        const url = `${baseEndpoint}/v1internal:streamGenerateContent?alt=sse`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": `antigravity/1.15.8 ${process.platform === "darwin" ? "darwin/arm64" : "linux/amd64"}`,
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
            "Client-Metadata": JSON.stringify({
              ideType: "ANTIGRAVITY",
              platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
              pluginType: "GEMINI",
            }),
          },
          body: JSON.stringify({
            project: projectId,
            model,
            requestType: "agent",
            userAgent: "antigravity",
            requestId: `agent-${randomUUID()}`,
            request: {
              contents: [{ role: "user", parts: [{ text: prompt }] }],
            },
          }),
          signal,
        });

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Antigravity API error (${resp.status}): ${text}`);
        }

        await parseGeminiSSEStream(resp.body!, signal, safeWrite, taskId);
        markOAuthAccountSuccess(account.id!);
        if (i > 0 && autoSwap && account.id) {
          setActiveOAuthAccount("google_antigravity", account.id);
          const swapMsg = `[antigravity] Promoted account in active pool: ${accountName}\n`;
          safeWrite(swapMsg);
          if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: swapMsg });
        }
        safeWrite(`\n---\n[antigravity] Done.\n`);
        if (taskId)
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: "\n---\n[antigravity] Done.\n" });
        return;
      } catch (err: unknown) {
        if (signal.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
        const msg = toErrorMessage(err);
        markOAuthAccountFailure(account.id!, msg);
        const failMsg = `[antigravity] Account ${accountName} failed: ${msg}\n`;
        safeWrite(failMsg);
        if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: failMsg });
        lastError = err instanceof Error ? err : new Error(msg);
        if (autoSwap && i + 1 < maxAttempts) {
          const nextName = getOAuthAccountDisplayName(accounts[i + 1]);
          const swapMsg = `[antigravity] Trying fallback account: ${nextName}\n`;
          safeWrite(swapMsg);
          if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: swapMsg });
        }
      }
    }

    throw lastError ?? new Error("No runnable Antigravity account available.");
  }

  function launchHttpAgent(
    taskId: string,
    agent: "copilot" | "antigravity",
    prompt: string,
    projectPath: string,
    logPath: string,
    controller: AbortController,
    fakePid: number,
    preferredOAuthAccountId?: string | null,
  ): void {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const { safeWrite, safeEnd } = createSafeLogStreamOps(logStream);
    safeWrite(`\n===== task run start ${new Date().toISOString()} | provider=${agent} =====\n`);

    const promptPath = path.join(logsDir, `${taskId}.prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf8");

    // Register mock ChildProcess so stop logic works uniformly
    const mockProc = {
      pid: fakePid,
      kill: () => {
        controller.abort();
        return true;
      },
    } as unknown as ChildProcess;
    activeProcesses.set(taskId, mockProc);

    const runTask = (async () => {
      let exitCode = 0;
      try {
        if (agent === "copilot") {
          await executeCopilotAgent(
            prompt,
            projectPath,
            logStream,
            controller.signal,
            taskId,
            preferredOAuthAccountId ?? null,
            safeWrite,
          );
        } else {
          await executeAntigravityAgent(
            prompt,
            logStream,
            controller.signal,
            taskId,
            preferredOAuthAccountId ?? null,
            safeWrite,
          );
        }
      } catch (err: unknown) {
        exitCode = 1;
        if (!(err instanceof Error && err.name === "AbortError")) {
          const errMsg = toErrorMessage(err);
          const msg = normalizeStreamChunk(`[${agent}] Error: ${errMsg}\n`);
          safeWrite(msg);
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: msg });
          log.error({ agent, taskId, errMsg }, "HTTP agent error");
        } else {
          const msg = normalizeStreamChunk(`[${agent}] Aborted by user\n`);
          safeWrite(msg);
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: msg });
        }
      } finally {
        await new Promise<void>((resolve) => safeEnd(resolve));
        try {
          fs.unlinkSync(promptPath);
        } catch {
          /* ignore */
        }
        handleTaskRunComplete(taskId, exitCode);
      }
    })();

    runTask.catch((err) => {
      log.error({ err }, "unhandled task execution error");
    });
  }

  return {
    parseHttpAgentSubtasks,
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
    executeCopilotAgent,
    executeAntigravityAgent,
    launchHttpAgent,
  };
}
