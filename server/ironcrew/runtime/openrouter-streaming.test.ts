import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenRouterRuntime } from "./openrouter-runtime.ts";
import type { OpenRouterToolExecutor } from "./openrouter-tools.ts";
import type { RunContext, RunEvent } from "./run-events.ts";

const ctx: RunContext = {
  companyId: "cmp_test",
  taskId: "task_test",
  runId: "run_test",
  agentId: "agent_test",
  projectId: null,
  correlationId: "corr_test",
  workspacePath: "/work",
  permissionMode: "restricted",
  sensitive: true,
};
const delta = (content: string, finish: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});
const usage = {
  choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
};
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const streamText = (...values: unknown[]) => values.map(frame).join("") + "data: [DONE]\n\n";
function response(text: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(stream: AsyncIterable<RunEvent>) {
  const out = [];
  for await (const event of stream) out.push(event);
  return out;
}
function toolFrame(args = '{"taskId":"task_test"}', name = "task_read") {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: args } }] },
        finish_reason: "tool_calls",
      },
    ],
  };
}
function executor(overrides: Partial<OpenRouterToolExecutor> = {}): OpenRouterToolExecutor {
  return {
    listTools: vi.fn(async () => [
      {
        name: "task_read",
        description: "Aufgabe lesen",
        inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
      },
    ]),
    authorize: vi.fn(async () => ({ status: "allowed" as const })),
    execute: vi.fn(async () => ({ title: "Prüfen" })),
    audit: vi.fn(async () => undefined),
    ...overrides,
  };
}
function runtime(responses: Response[], toolExecutor?: OpenRouterToolExecutor) {
  const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  });
  return { rt: new OpenRouterRuntime({ apiKey: "local-fixture-secret", fetchImpl, toolExecutor }), fetchImpl };
}

describe("OpenRouter streaming transport", () => {
  it("decodes split UTF-8, comments, CRLF and the repeated final usage finish exactly once", async () => {
    const wire =
      ": OPENROUTER PROCESSING\r\n\r\n" +
      streamText(delta("Grüße\n"), delta("fertig", "stop"), usage).replaceAll("\n", "\r\n");
    const { rt, fetchImpl } = runtime([response(wire, 1)]);
    const events = await collect(rt.startRun({ prompt: "x" }, ctx));
    expect(
      events
        .filter((e) => e.type === "message.delta")
        .map((e) => e.payload.text)
        .join(""),
    ).toBe("Grüße\nfertig");
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "usage.updated")).toHaveLength(1);
    expect(events.find((e) => e.type === "usage.updated")?.payload.costMicros).toBe(1000);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.stream).toBe(true);
    expect(body.provider).toMatchObject({ allow_fallbacks: false, data_collection: "deny", zdr: true });
  });

  it("handles multiline SSE data and an empty-choice usage frame", async () => {
    const content =
      JSON.stringify(delta("done", "stop"), null, 2)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n") + "\n\n";
    const { rt } = runtime([response(content + streamText({ choices: [], usage: usage.usage }))]);
    expect((await collect(rt.startRun({ prompt: "x" }, ctx))).at(-1)?.type).toBe("run.completed");
  });

  it.each([
    ["truncated", frame(delta("partial"))],
    ["malformed JSON", "data: {broken}\n\ndata: [DONE]\n\n"],
    ["malformed choice", streamText({ choices: "wrong" })],
    ["missing finish", streamText(delta("partial"))],
    ["token limit", streamText(delta("partial", "length"))],
    ["provider error", streamText({ error: { code: "server_error", message: "Disconnected" } })],
  ])("fails closed on %s", async (_label, wire) => {
    const { rt } = runtime([response(wire)]);
    const events = await collect(rt.startRun({ prompt: "x" }, ctx));
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });

  it("normalizes an in-stream rate limit as waiting", async () => {
    const { rt } = runtime([response(streamText({ error: { code: 429, message: "Quota" } }))]);
    const events = await collect(rt.startRun({ prompt: "x" }, ctx));
    expect(events.map((e) => e.type)).toEqual(["run.started", "rate_limit.detected", "run.waiting"]);
  });

  it("redacts a secret split across model content deltas", async () => {
    const { rt } = runtime([response(streamText(delta("local-fixture-"), delta("secret\n", "stop")))]);
    const events = await collect(rt.startRun({ prompt: "x" }, ctx));
    expect(JSON.stringify(events)).not.toContain("local-fixture-secret");
    expect(events.find((e) => e.type === "message.completed")?.payload.text).toBe("[REDACTED]\n");
  });

  it("cancels an idle SSE reader through cancelRun", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const { rt } = runtime([new Response(body, { headers: { "content-type": "text/event-stream" } })]);
    const result = collect(rt.startRun({ prompt: "x" }, ctx));
    await ready;
    await rt.cancelRun(ctx.runId);
    expect((await result).at(-1)?.type).toBe("run.cancelled");
    expect(cancel).toHaveBeenCalled();
  });
});

describe("OpenRouter audited client tools", () => {
  it("assembles fragmented arguments, audits a permitted tool and feeds its redacted result into a bounded next round", async () => {
    const calls = executor({ execute: vi.fn(async () => ({ title: "Result", password: "not-for-the-model" })) });
    const first = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "task_read", arguments: '{"task' } },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const second = {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"task_test"}' } }] },
          finish_reason: "tool_calls",
        },
      ],
    };
    const { rt, fetchImpl } = runtime(
      [response(streamText(first, second)), response(streamText(delta("Erledigt", "stop")))],
      calls,
    );
    const events = await collect(rt.startRun({ prompt: "x", maxTurns: 2 }, ctx));
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(calls.execute).toHaveBeenCalledWith(
      { id: "call_1", name: "task_read", arguments: { taskId: "task_test" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(vi.mocked(calls.audit).mock.calls.map((call) => call[0])).toEqual(["requested", "started", "completed"]);
    const body = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(body.messages[1].tool_calls[0].id).toBe("call_1");
    expect(body.messages[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(body.messages[2].content).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("not-for-the-model");
    expect(body.tools[0].function.name).toBe("task_read");
    expect(body.provider).toMatchObject({ require_parameters: true, allow_fallbacks: false, zdr: true });
    expect(body.max_tokens).toBe(4096); // maxTurns counts rounds, not tokens
  });

  it.each([
    ["unlisted tool", '{"taskId":"task_test"}', "shell_exec"],
    ["invalid arguments", '{"taskId":42}', "task_read"],
    ["argument injection", '{"taskId":"task_test","companyId":"other"}', "task_read"],
    ["invalid JSON", '{"taskId":', "task_read"],
  ])("refuses %s before authorization or execution", async (_label, args, name) => {
    const tools = executor();
    const { rt } = runtime([response(streamText(toolFrame(args, name)))], tools);
    expect((await collect(rt.startRun({ prompt: "x" }, ctx))).at(-1)?.type).toBe("run.failed");
    expect(tools.authorize).not.toHaveBeenCalled();
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("parks approval-required calls without executing or making another request", async () => {
    const tools = executor({
      authorize: vi.fn(async () => ({
        status: "approval_required" as const,
        approvalType: "tier0_change",
        summary: "Freigeben",
      })),
    });
    const { rt, fetchImpl } = runtime([response(streamText(toolFrame()))], tools);
    const events = await collect(rt.startRun({ prompt: "x" }, ctx));
    expect(events.at(-1)?.type).toBe("run.waiting");
    expect(events.some((e) => e.type === "approval.required")).toBe(true);
    expect(tools.execute).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["denied", "audit failure"])("fails closed on %s", async (mode) => {
    const tools = executor(
      mode === "denied"
        ? { authorize: vi.fn(async () => ({ status: "denied" as const, reason: "Revoked" })) }
        : {
            audit: vi.fn(async () => {
              throw new Error("Audit unavailable");
            }),
          },
    );
    const { rt } = runtime([response(streamText(toolFrame()))], tools);
    expect((await collect(rt.startRun({ prompt: "x" }, ctx))).at(-1)?.type).toBe("run.failed");
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it("limits the agent loop and declares tools only when an executor exists", async () => {
    const tools = executor();
    const { rt, fetchImpl } = runtime([response(streamText(toolFrame()))], tools);
    expect((await collect(rt.startRun({ prompt: "x", maxTurns: 1 }, ctx))).at(-1)?.type).toBe("run.failed");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await rt.capabilities()).toolCalls).toBe(true);
    const without = runtime([response(streamText(toolFrame()))]);
    expect((await without.rt.capabilities()).toolCalls).toBe(false);
    expect((await collect(without.rt.startRun({ prompt: "x" }, ctx))).at(-1)?.type).toBe("run.failed");
  });

  it("times out a stalled executor without another model round", async () => {
    vi.useFakeTimers();
    try {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const tools = executor({
        execute: vi.fn(async () => {
          started();
          return new Promise<never>(() => undefined);
        }),
      });
      const fetchImpl = vi.fn(async () => response(streamText(toolFrame())));
      const rt = new OpenRouterRuntime({ apiKey: "fixture-secret", fetchImpl, toolExecutor: tools, timeoutMs: 1000 });
      const result = collect(rt.startRun({ prompt: "x" }, ctx));
      await ready;
      await vi.advanceTimersByTimeAsync(1000);
      const events = await result;
      expect(events.at(-1)).toMatchObject({ type: "run.failed", payload: { code: "timeout" } });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
