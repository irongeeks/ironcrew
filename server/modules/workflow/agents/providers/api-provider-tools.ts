import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { decryptSecret } from "../../../../oauth/helpers.ts";
import type { ApiProviderRow } from "./types.ts";
import { toErrorMessage } from "../../../routes/validation.ts";
import { logger } from "../../../../observability/logger.ts";
import { isBlockedSsrfTarget, SsrfBlockedError } from "../../../../security/ssrf.ts";
import { safeFetch } from "../../../../security/safe-fetch.ts";

const log = logger.child({ module: "workflow-agents" });

type DbLike = {
  prepare: (sql: string) => {
    get: (...args: any[]) => unknown;
  };
};

type CreateApiProviderToolsDeps = {
  db: DbLike;
  logsDir: string;
  activeProcesses: Map<string, ChildProcess>;
  broadcast: (event: string, payload: unknown) => void;
  normalizeStreamChunk: (raw: Buffer | string, opts?: { dropCliNoise?: boolean }) => string;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  createSafeLogStreamOps: (logStream: any) => {
    safeWrite: (text: string) => boolean;
    safeEnd: (onDone?: () => void) => void;
    isClosed: () => boolean;
  };
  parseSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
  ) => Promise<void>;
  parseGeminiSSEStream: (
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
  ) => Promise<void>;
};

export function createApiProviderTools(deps: CreateApiProviderToolsDeps) {
  const {
    db,
    logsDir,
    activeProcesses,
    broadcast,
    normalizeStreamChunk,
    handleTaskRunComplete,
    createSafeLogStreamOps,
    parseSSEStream,
    parseGeminiSSEStream,
  } = deps;

  async function parseAnthropicSSEStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    safeWrite: (text: string) => boolean,
    taskId?: string,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    const processLine = (trimmed: string) => {
      if (!trimmed || trimmed.startsWith(":")) return;
      if (!trimmed.startsWith("data: ")) return;
      if (trimmed === "data: [DONE]") return;
      try {
        const data = JSON.parse(trimmed.slice(6));
        if (data.type === "content_block_delta" && data.delta?.text) {
          const text = normalizeStreamChunk(data.delta.text);
          if (!text) return;
          safeWrite(text);
          if (taskId) {
            broadcast("cli_output", { task_id: taskId, stream: "stdout", data: text });
          }
        }
      } catch {
        /* ignore */
      }
    };

    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (signal.aborted) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line.trim());
    }
    if (buffer.trim()) processLine(buffer.trim());
  }

  function getApiProviderById(providerId: string): ApiProviderRow | null {
    return (
      (db.prepare("SELECT * FROM api_providers WHERE id = ?").get(providerId) as unknown as ApiProviderRow) ?? null
    );
  }

  function resolveApiProviderModel(provider: ApiProviderRow, requestedModel: string | null): string {
    if (requestedModel) return requestedModel;
    if (provider.models_cache) {
      try {
        const models = JSON.parse(provider.models_cache) as string[];
        if (models.length > 0) return models[0];
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `No model specified for API provider '${provider.name}'. ` +
        `Please select a model in the agent settings or run a connection test first to cache available models.`,
    );
  }

  function normalizeApiBaseUrl(rawUrl: string): string {
    let url = rawUrl.replace(/\/+$/, "");
    url = url.replace(/\/(v\d+)\/(chat\/completions|models|messages)$/i, "/$1");
    url = url.replace(/\/v1beta\/models\/.+$/i, "/v1beta");
    return url;
  }

  function buildApiProviderRequest(
    provider: ApiProviderRow,
    model: string,
    prompt: string,
    projectPath: string,
  ): { url: string; headers: Record<string, string>; body: string } {
    const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : "";
    const baseUrl = normalizeApiBaseUrl(provider.base_url);

    if (provider.type === "anthropic") {
      const messagesUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
      return {
        url: messagesUrl,
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          stream: true,
          messages: [{ role: "user", content: `Project path: ${projectPath}\n\nRespond now.` }],
          system: prompt,
        }),
      };
    }

    if (provider.type === "google") {
      const googleBase = baseUrl.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
      const url = `${googleBase}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
      return {
        url,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Project path: ${projectPath}\n\nRespond now.` }] }],
          systemInstruction: { parts: [{ text: prompt }] },
        }),
      };
    }

    const chatUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (provider.type === "openrouter") {
      headers["HTTP-Referer"] = "https://ironcrew.app";
      headers["X-Title"] = "IronCrew";
    }

    return {
      url: chatUrl,
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: `Project path: ${projectPath}\n\nRespond now.` },
        ],
        stream: true,
      }),
    };
  }

  async function executeApiProviderAgent(
    prompt: string,
    projectPath: string,
    logStream: fs.WriteStream,
    signal: AbortSignal,
    taskId?: string,
    apiProviderId?: string | null,
    apiModel?: string | null,
    safeWriteOverride?: (text: string) => boolean,
  ): Promise<void> {
    const safeWrite = safeWriteOverride ?? createSafeLogStreamOps(logStream).safeWrite;

    if (!apiProviderId) {
      throw new Error("No API provider configured for this agent. Set api_provider_id first.");
    }

    const provider = getApiProviderById(apiProviderId);
    if (!provider) {
      throw new Error(`API provider not found: ${apiProviderId}`);
    }
    if (!provider.enabled) {
      throw new Error(`API provider '${provider.name}' is disabled.`);
    }

    const model = resolveApiProviderModel(provider, apiModel ?? null);
    const header = `[api:${provider.type}] Provider: ${provider.name}, Model: ${model}\n---\n`;
    safeWrite(header);
    if (taskId) broadcast("cli_output", { task_id: taskId, stream: "stderr", data: header });

    const req = buildApiProviderRequest(provider, model, prompt, projectPath);

    // SSRF check: strict by default, but allow local/private targets when the
    // provider has allow_local enabled (e.g. Ollama, LM Studio, local gateways).
    // Cheap string-based fast-fail first…
    if (isBlockedSsrfTarget(req.url, { allowLocal: !!provider.allow_local })) {
      throw new Error(`API provider '${provider.name}' base_url targets a blocked address range (SSRF protection)`);
    }
    // …then resolve DNS AND pin the IP through the dispatcher to defeat
    // rebinding attacks (A-002).  safeFetch() runs assertSsrfSafeUrl() and
    // then carries the validated IP into undici's connect.lookup so the
    // underlying TCP connect cannot re-resolve to a private/metadata IP.
    let resp: Response;
    try {
      resp = await safeFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal,
        allowLocal: !!provider.allow_local,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new Error(`API provider '${provider.name}' base_url targets a blocked address range (SSRF protection)`);
      }
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API provider '${provider.name}' error (${resp.status}): ${text}`);
    }

    if (provider.type === "anthropic") {
      await parseAnthropicSSEStream(resp.body!, signal, safeWrite, taskId);
    } else if (provider.type === "google") {
      await parseGeminiSSEStream(resp.body!, signal, safeWrite, taskId);
    } else {
      await parseSSEStream(resp.body!, signal, safeWrite, taskId);
    }

    safeWrite(`\n---\n[api:${provider.type}] Done.\n`);
    if (taskId) {
      broadcast("cli_output", { task_id: taskId, stream: "stderr", data: `\n---\n[api:${provider.type}] Done.\n` });
    }
  }

  function launchApiProviderAgent(
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    projectPath: string,
    logPath: string,
    controller: AbortController,
    fakePid: number,
  ): void {
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const { safeWrite, safeEnd } = createSafeLogStreamOps(logStream);
    safeWrite(`\n===== task run start ${new Date().toISOString()} | provider=api =====\n`);

    const promptPath = path.join(logsDir, `${taskId}.prompt.txt`);
    fs.writeFileSync(promptPath, prompt, "utf8");

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
        await executeApiProviderAgent(
          prompt,
          projectPath,
          logStream,
          controller.signal,
          taskId,
          apiProviderId,
          apiModel,
          safeWrite,
        );
      } catch (err: unknown) {
        exitCode = 1;
        if (!(err instanceof Error && err.name === "AbortError")) {
          const errMsg = toErrorMessage(err);
          const msg = normalizeStreamChunk(`[api] Error: ${errMsg}\n`);
          safeWrite(msg);
          broadcast("cli_output", { task_id: taskId, stream: "stderr", data: msg });
          log.error({ taskId, errMsg }, "API provider agent error");
        } else {
          const msg = normalizeStreamChunk(`[api] Aborted by user\n`);
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
    executeApiProviderAgent,
    launchApiProviderAgent,
  };
}
