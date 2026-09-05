import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerSecretRuntime, parseRunnerSecretRef } from "./secret-runtime.ts";
import { RunnerServer } from "./runner-server.ts";
import { RunnerRuntime } from "./runner-client.ts";
import { socketPair } from "./__fixtures__/socket-pair.ts";
import { OpenRouterRuntime } from "../runtime/openrouter-runtime.ts";
import { RunnerWorkspaceTools } from "./workspace-tools.ts";
import type { RunContext, RunEvent } from "../runtime/run-events.ts";
import type { SecretProvider } from "../secrets/secret-provider.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-secret-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const collect = async (events: AsyncIterable<RunEvent>) => {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

function setup(resolve = vi.fn(async () => "runner-only-credential-123456")) {
  const ref = { provider: "keychain" as const, itemRef: "ironcrew/openrouter" };
  const provider: SecretProvider = {
    kind: "keychain",
    resolve,
    testConnection: vi.fn(async () => ({ ok: true, message: "ready" })),
  };
  const requests: RequestInit[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(init!);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "runner-only-credential-123456" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const tools = new RunnerWorkspaceTools(path.join(dir, "audit", "tools.ndjson"));
  const factory = vi.fn((apiKey: string) => new OpenRouterRuntime({ apiKey, fetchImpl, toolExecutor: tools }));
  const runtime = new RunnerSecretRuntime({
    runtimeType: "openrouter",
    secretRef: ref,
    providers: new Map([["keychain", provider]]),
    createRuntime: factory,
    capabilities: {
      workspaceRequired: false,
      streaming: true,
      sessionResume: false,
      usageReporting: true,
      costReporting: true,
      toolCalls: true,
      subagents: false,
      defaultConcurrency: 6,
    },
  });
  const server = new RunnerServer({ workspaceRoot: dir, token: "transport-auth", runtimes: [runtime] });
  const pairs: ReturnType<typeof socketPair>[] = [];
  const client = new RunnerRuntime({
    runtimeType: "openrouter",
    token: "transport-auth",
    connect: async () => {
      const pair = socketPair();
      pairs.push(pair);
      server.handleConnection(pair.server);
      return pair.client;
    },
  });
  const context: RunContext = {
    companyId: "company-1",
    projectId: "project-1",
    taskId: "task-1",
    runId: "run-1",
    agentId: "agent-1",
    correlationId: "correlation-1",
    workspacePath: dir,
    permissionMode: "restricted",
    sensitive: true,
    allowedTools: ["workspace.read", "workspace.list"],
  };
  return { resolve, provider, requests, factory, runtime, client, context, pairs, fetchImpl };
}

describe("runner-only SecretRef runtime", () => {
  it("does not execute an OpenRouter tool or issue a second model request after the first usage is rejected", async () => {
    const test = setup();
    fs.writeFileSync(path.join(dir, "readme.md"), "Project contents");
    vi.mocked(test.fetchImpl).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "budget-call",
                      type: "function",
                      function: { name: "workspace_read", arguments: '{"path":"readme.md"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { cost: 0.01, prompt_tokens: 5, completion_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const abort = new AbortController();
    const events: RunEvent[] = [];
    for await (const event of test.client.startRun(
      { prompt: "Read project" },
      { ...test.context, signal: abort.signal },
    )) {
      events.push(event);
      if (event.type === "usage.updated") abort.abort(new Error("Budget rejected this spend."));
    }
    expect(test.fetchImpl).toHaveBeenCalledOnce();
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.some((event) => event.type.startsWith("tool."))).toBe(false);
    expect(fs.existsSync(path.join(dir, "audit", "tools.ndjson"))).toBe(false);
    expect(test.pairs.flatMap((pair) => pair.traffic).some((line) => JSON.parse(line).kind === "usage-ack")).toBe(
      false,
    );
  });

  it("executes an allowed native workspace tool and returns its audited result to the model", async () => {
    const test = setup();
    fs.writeFileSync(path.join(dir, "readme.md"), "Verified project context.");
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.mocked(test.fetchImpl).mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const message =
        bodies.length === 1
          ? {
              content: null,
              tool_calls: [
                {
                  id: "read-call",
                  type: "function",
                  function: { name: "workspace_read", arguments: '{"path":"readme.md"}' },
                },
              ],
            }
          : { content: "Projekt gelesen." };
      return new Response(
        JSON.stringify({
          choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const events = await collect(test.client.startRun({ prompt: "Lies die Projektdokumentation." }, test.context));
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.requested", "tool.started", "tool.completed"]),
    );
    expect(bodies).toHaveLength(2);
    expect(
      bodies[1].messages.some(
        (message) => message.role === "tool" && message.content.includes("Verified project context."),
      ),
    ).toBe(true);
    const audit = fs.readFileSync(path.join(dir, "audit", "tools.ndjson"), "utf-8");
    expect(audit).toContain('"stage":"started"');
    expect(audit).toContain('"stage":"completed"');
    expect(audit).not.toContain("runner-only-credential-123456");
  });

  it("runs actual OpenRouter HTTP logic behind the runner without sending its key across the socket", async () => {
    const test = setup();
    expect(await test.client.authStatus()).toMatchObject({ authenticated: false, verification: "unverified" });
    expect((await test.client.healthCheck()).healthy).toBe(true);
    expect((await test.client.capabilities()).toolCalls).toBe(true);
    expect(test.resolve).not.toHaveBeenCalled();
    const events = await collect(test.client.startRun({ prompt: "Bitte prüfen." }, test.context));
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(test.resolve).toHaveBeenCalledOnce();
    expect(test.requests[0].headers).toMatchObject({ Authorization: "Bearer runner-only-credential-123456" });
    const wire = test.pairs.flatMap((pair) => pair.traffic).join("\n");
    expect(wire).not.toContain("runner-only-credential-123456");
    expect(JSON.stringify(events)).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("runner-only-credential-123456");
  });

  it("executes text-only jobs without a workspace and never advertises file tools for them", async () => {
    const test = setup();
    const events = await collect(
      test.client.startRun(
        { prompt: "Fasse den Auftrag zusammen." },
        { ...test.context, projectId: null, workspacePath: "" },
      ),
    );
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(JSON.parse(String(test.requests[0].body)).tools).toBeUndefined();
  });

  it("resolves again for rotation and releases the runtime after every run", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce("first-credential-123456")
      .mockResolvedValueOnce("rotated-credential-654321");
    const test = setup(resolve);
    await collect(test.client.startRun({ prompt: "Eins" }, test.context));
    await collect(test.client.startRun({ prompt: "Zwei" }, { ...test.context, runId: "run-2" }));
    expect(test.resolve).toHaveBeenCalledTimes(2);
    expect(test.factory).toHaveBeenNthCalledWith(1, "first-credential-123456");
    expect(test.factory).toHaveBeenNthCalledWith(2, "rotated-credential-654321");
    expect(test.pairs.flatMap((pair) => pair.traffic).join()).not.toContain("rotated-credential-654321");
  });

  it("never forwards a vault exception which might contain plaintext", async () => {
    const test = setup(
      vi.fn(async () => {
        throw new Error("vault stdout contains unknown-credential-value");
      }),
    );
    const events = await collect(test.client.startRun({ prompt: "Prüfen" }, test.context));
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(test.fetchImpl).not.toHaveBeenCalled();
    expect(test.pairs.flatMap((pair) => pair.traffic).join()).not.toContain("unknown-credential-value");
  });

  it("does not resolve a credential for a pre-cancelled task", async () => {
    const test = setup();
    const abort = new AbortController();
    abort.abort();
    const events = await collect(
      test.runtime.startRun({ prompt: "Prüfen" }, { ...test.context, signal: abort.signal }),
    );
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(test.resolve).not.toHaveBeenCalled();
  });

  it("accepts only typed references, not raw keys or unknown JSON fields", () => {
    expect(parseRunnerSecretRef(undefined)).toBeNull();
    expect(parseRunnerSecretRef('{"provider":"keychain","itemRef":"ironcrew/openrouter"}')).toEqual({
      provider: "keychain",
      itemRef: "ironcrew/openrouter",
    });
    expect(() => parseRunnerSecretRef("plaintext-secret")).toThrow(/JSON SecretRef/);
    expect(() => parseRunnerSecretRef('{"provider":"keychain","itemRef":"x","apiKey":"secret"}')).toThrow(
      /JSON SecretRef/,
    );
  });
});
