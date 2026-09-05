/**
 * The first runtime that is not a CLI.
 *
 * Most of these tests are about one thing: OpenRouter is a *router*. One key
 * reaches hundreds of models from dozens of vendors, including ones this
 * project refuses on principle — so the vendor policy has to be enforced
 * here, before the request is built. A policy checked after the answer comes
 * back is a policy that has already been broken.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { OpenRouterRuntime } from "./openrouter-runtime.ts";
import * as vendorPolicy from "../policy/vendor-policy.ts";
import type { RunContext, RunEvent } from "./run-events.ts";

function context(over: Partial<RunContext> = {}): RunContext {
  return {
    companyId: "cmp_1",
    projectId: null,
    taskId: "task_1",
    runId: "run_1",
    agentId: "agt_1",
    correlationId: "corr_1",
    workspacePath: "/tmp/ws",
    permissionMode: "restricted",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
}

const COMPLETION = {
  choices: [{ message: { content: "Analyse abgeschlossen." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 120, completion_tokens: 45, cost: 0.0021 },
};

function runtime(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new OpenRouterRuntime({ apiKey: "sk-or-geheim", fetchImpl, ...over });
}

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("a normal completion", () => {
  it("emits started, usage, message and completed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "Hallo" }, context()));

    expect(events.map((e) => e.type)).toEqual(["run.started", "usage.updated", "message.completed", "run.completed"]);
    expect(events[2].payload.text).toBe("Analyse abgeschlossen.");
  });

  it("reports the real charge rather than an estimate", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "Hallo" }, context()));

    const usage = events.find((e) => e.type === "usage.updated")!;
    expect(usage.payload).toMatchObject({ inputTokens: 120, outputTokens: 45, costMicros: 2100 });
  });

  it("sends the key as a header, never in the URL or the body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;

    await collect(runtime(fetchImpl).startRun({ prompt: "Hallo" }, context()));

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-geheim");
    expect(calls[0].url).not.toContain("sk-or-geheim");
    expect(String(calls[0].init?.body)).not.toContain("sk-or-geheim");
  });

  it("uses the model it was given, and a default when it was given none", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;

    const rt = runtime(fetchImpl, { defaultModel: "anthropic/claude-sonnet-4.5" });
    await collect(rt.startRun({ prompt: "x", model: "anthropic/claude-opus-4.1" }, context()));
    await collect(rt.startRun({ prompt: "x" }, context()));

    expect(bodies[0]).toContain("anthropic/claude-opus-4.1");
    expect(bodies[1]).toContain("anthropic/claude-sonnet-4.5");
  });
});

describe("vendor policy is enforced before the request is built", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([true, undefined])("pins providers and privacy for sensitive=%s in the actual request", async (sensitive) => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;

    await collect(runtime(fetchImpl).startRun({ prompt: "Analyse", model: "openai/gpt-4.1" }, context({ sensitive })));

    expect(sent.provider).toEqual({
      order: vendorPolicy.getVendorPolicy().openrouter.allowed_providers,
      only: vendorPolicy.getVendorPolicy().openrouter.allowed_providers,
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    });
  });

  it("keeps provider restrictions for explicitly non-sensitive tasks", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;

    await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context({ sensitive: false })));

    expect(sent.provider).toEqual({
      order: vendorPolicy.getVendorPolicy().openrouter.allowed_providers,
      only: vendorPolicy.getVendorPolicy().openrouter.allowed_providers,
      allow_fallbacks: false,
    });
  });

  it("fails closed without a request when no upstream provider is allowed", async () => {
    const policy = vendorPolicy.getVendorPolicy();
    vi.spyOn(vendorPolicy, "getVendorPolicy").mockReturnValue({
      ...policy,
      openrouter: { ...policy.openrouter, allowed_providers: [] },
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));

    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
    expect(events[0].payload.code).toBe("no_allowed_providers");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a blocked vendor without calling out at all", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const events = await collect(
      runtime(fetchImpl).startRun({ prompt: "x", model: "deepseek/deepseek-chat" }, context()),
    );

    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
    expect(String(events[0].payload.message)).toMatch(/Vendor-Policy/);
    // The whole point: nothing was sent. A policy checked after the answer
    // arrives is a policy that has already been broken.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the policy code, so an operator can find the rule", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const events = await collect(
      runtime(fetchImpl).startRun({ prompt: "x", model: "qwen/qwen-2.5-72b-instruct" }, context()),
    );
    expect(events[0].payload.code).toBeTruthy();
  });

  it("refuses an empty model rather than letting the router choose", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const rt = new OpenRouterRuntime({ apiKey: "k", fetchImpl, defaultModel: "   " });
    const events = await collect(rt.startRun({ prompt: "x", model: "  " }, context()));
    expect(events[0].type).toBe("run.failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("failures are told apart", () => {
  it("treats a rate limit as 'try later', not as a bad task", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));

    expect(events.map((e) => e.type)).toEqual(["run.started", "rate_limit.detected", "run.waiting"]);
  });

  it("reports another HTTP error with its status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502)) as unknown as typeof fetch;
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    expect(String(events.at(-1)!.payload.message)).toContain("502");
  });

  it("reports a body that is not JSON rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("no");
      },
    })) as unknown as typeof fetch;

    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    expect(events.at(-1)!.type).toBe("run.failed");
  });

  it("surfaces an error the API reported in a 200 body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "model not found" } }),
    ) as unknown as typeof fetch;

    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    expect(String(events.at(-1)!.payload.message)).toContain("model not found");
  });

  it("treats an empty completion as a failure, not a silent success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "" } }], usage: {} }),
    ) as unknown as typeof fetch;

    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    // A task moved to review with no result wastes a human's attention.
    expect(events.at(-1)!.type).toBe("run.failed");
  });

  it("reports a transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    expect(String(events.at(-1)!.payload.message)).toContain("ECONNRESET");
  });
});

describe("cancellation", () => {
  it.each([
    ["headers", "runtime"],
    ["body", "runtime"],
    ["headers", "context"],
    ["body", "context"],
  ])("cancels while reading %s through %s cancellation", async (phase, source) => {
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const waitForAbort = () =>
      new Promise<never>((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true });
        ready();
      });
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      if (phase === "headers") return waitForAbort();
      return { ok: true, status: 200, json: waitForAbort } as unknown as Response;
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const rt = runtime(fetchImpl);
    const result = collect(rt.startRun({ prompt: "x" }, context({ signal: controller.signal })));
    await reading;

    if (source === "runtime") await rt.cancelRun("run_1");
    else controller.abort();

    expect((await result).map((event) => event.type)).toEqual(["run.started", "run.cancelled"]);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps the timeout active until the response body has been consumed", async () => {
    vi.useFakeTimers();
    try {
      let ready!: () => void;
      const reading = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise<never>((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
            ready();
          }),
      })) as unknown as typeof fetch;
      const result = collect(runtime(fetchImpl, { timeoutMs: 1000 }).startRun({ prompt: "x" }, context()));
      await reading;

      await vi.advanceTimersByTimeAsync(1000);

      const events = await result;
      expect(events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
      expect(events.at(-1)?.payload.code).toBe("timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops before sending when already aborted", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const abort = new AbortController();
    abort.abort();

    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context({ signal: abort.signal })));
    expect(events.at(-1)!.type).toBe("run.cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts the request itself, not just our listening", async () => {
    let sawSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;

    await collect(runtime(fetchImpl).startRun({ prompt: "x" }, context()));
    // A vessel timeout that only stopped us reading would leave the request
    // running and the tokens spent.
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it("honours cancelRun", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const rt = runtime(fetchImpl);
    await rt.cancelRun("run_1");

    const events = await collect(rt.startRun({ prompt: "x" }, context()));
    expect(events.at(-1)!.type).toBe("run.cancelled");
  });
});

describe("status probes", () => {
  it("reports health from the models endpoint", async () => {
    const ok = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    expect(await runtime(ok).healthCheck()).toMatchObject({ healthy: true, installed: true });

    const down = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await runtime(down).healthCheck()).toMatchObject({ healthy: false });
  });

  it("reports auth without ever echoing the key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { label: "prod" } })) as unknown as typeof fetch;
    const status = await runtime(fetchImpl).authStatus();

    expect(status).toMatchObject({ authenticated: true, method: "api-key" });
    expect(JSON.stringify(status)).not.toContain("sk-or-geheim");
  });

  it("says plainly when no key is configured, and how to fix it", async () => {
    const rt = new OpenRouterRuntime({ apiKey: "", fetchImpl: vi.fn() as unknown as typeof fetch });
    const status = await rt.authStatus();
    expect(status.authenticated).toBe(false);
    expect(status.setupHint).toContain("OPENROUTER_API_KEY");
  });

  it("declares that it reports real cost", async () => {
    const caps = await runtime(vi.fn() as unknown as typeof fetch).capabilities();
    expect(caps.costReporting).toBe(true);
    expect(caps.usageReporting).toBe(true);
  });
});

describe("company restrictions inside direct OpenRouter invocation", () => {
  it("uses the current trusted company resolver for every new invocation", async () => {
    let allowed = true;
    const policy = vendorPolicy.getVendorPolicy();
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const resolver = vi.fn(() => ({ ...policy, allowed_families: allowed ? ["anthropic/*"] : ["openai/*"] }));
    const rt = new OpenRouterRuntime({ apiKey: "fixture", fetchImpl, vendorPolicy: resolver });
    await collect(rt.startRun({ prompt: "x" }, context()));
    allowed = false;
    const events = await collect(rt.startRun({ prompt: "x" }, context()));
    expect(resolver).toHaveBeenLastCalledWith("cmp_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
  });
  it("pins company provider intersection and cannot relax local privacy or vendor blocks", async () => {
    const baseline = vendorPolicy.getVendorPolicy();
    const provider = baseline.openrouter.allowed_providers[0];
    let body: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse(COMPLETION);
    }) as unknown as typeof fetch;
    const ctx = context({
      vendorRestrictions: {
        allowedFamilies: ["anthropic/*", "deepseek/*", "*/*"],
        allowedProviders: [provider, "unapproved-host"],
      },
    });
    await collect(runtime(fetchImpl).startRun({ prompt: "x" }, ctx));
    expect(body.provider).toMatchObject({
      only: [provider],
      order: [provider],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    });
    const events = await collect(runtime(fetchImpl).startRun({ prompt: "x", model: "deepseek/example" }, ctx));
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["families", "providers"])("fails closed on an empty %s intersection before fetch", async (empty) => {
    const fetchImpl = vi.fn(async () => jsonResponse(COMPLETION)) as unknown as typeof fetch;
    const events = await collect(
      runtime(fetchImpl).startRun(
        { prompt: "x" },
        context({
          vendorRestrictions: {
            allowedFamilies: empty === "families" ? [] : ["anthropic/*"],
            allowedProviders: empty === "providers" ? [] : vendorPolicy.getVendorPolicy().openrouter.allowed_providers,
          },
        }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["run.failed"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
