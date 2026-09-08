import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { ProtonPassResolver } from "../../packages/integrations/src/index.ts";

const files = vi.hoisted(() => ({ readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  ...files,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let pricing: Record<string, string | undefined>;
let finalContent: string | undefined;
let requests: { max_tokens: number; model: string }[];
let resolveSecret: MockInstance<ProtonPassResolver["resolve"]>;

function profile(limit: unknown) {
  files.readFile.mockResolvedValue(
    JSON.stringify({
      name: "synthetic live contract",
      authorized: true,
      maxCostUsdMicros: limit,
      proton: { executable: process.execPath },
      openrouter: {
        modelId: "fixture/reasoning:free",
        secretRef: { provider: "proton-pass", shareId: "share", itemId: "item", field: "password" },
      },
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.argv = [process.execPath, "live.ts", "--profile", "synthetic-profile.json"];
  process.exitCode = undefined;
  pricing = { prompt: "0", completion: "0" };
  finalContent = "IronCrew";
  requests = [];
  // Mock the external secret boundary while retaining the real OpenRouter request and stream parser.
  resolveSecret = vi.spyOn(ProtonPassResolver.prototype, "resolve").mockResolvedValue("synthetic-key");
  vi.doMock("../../packages/integrations/src/index.ts", async (original) => ({
    ...(await original<typeof import("../../packages/integrations/src/index.ts")>()),
    ProtonPassResolver,
  }));
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models?output_modalities=all"))
        return Response.json({ data: [{ id: "fixture/reasoning:free", name: "Fixture", pricing }] });
      if (!url.endsWith("/chat/completions")) throw new Error("Unexpected fixture request");
      requests.push(JSON.parse(init!.body as string));
      const events = [
        { id: "gen-fixture", choices: [{ delta: { reasoning: "private reasoning fixture" } }] },
        {
          choices: [{ delta: { content: finalContent }, finish_reason: finalContent ? "stop" : "length" }],
          usage: { cost: 0 },
        },
      ];
      return new Response(
        events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n",
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }),
  );
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("permits an explicitly authorized zero-cost catalog model with a zero budget", async () => {
  profile("0");
  await import("../../scripts/live.ts");
  expect(requests).toHaveLength(1);
  expect(JSON.parse(files.writeFile.mock.lastCall![1])).toMatchObject({
    reservedUsdMicros: "0",
    costUsdMicros: "0",
    hasNonemptyResponse: true,
    state: "complete",
  });
  expect(process.exitCode).toBeUndefined();
});

it.each(["-1", "00", "01", "1.5", "1e3", "", 0])(
  "rejects a noncanonical cost limit %j before any network or secret access",
  async (limit) => {
    profile(limit);
    await expect(import("../../scripts/live.ts")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
  },
);

it.each([{ prompt: "0", completion: "0.000001" }, {}])(
  "does not dispatch a paid or unpriced model with a zero budget: %j",
  async (rates) => {
    pricing = rates;
    profile("0");
    await expect(import("../../scripts/live.ts")).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(files.writeFile).not.toHaveBeenCalled();
  },
);

it("reserves all 512 tokens before dispatch, even when a smaller output would fit the budget", async () => {
  pricing = { prompt: "0", completion: "0.000001" };
  profile("16");
  await expect(import("../../scripts/live.ts")).rejects.toThrow("Test cost reservation exceeds profile limit");
  expect(requests).toHaveLength(0);
  expect(resolveSecret).not.toHaveBeenCalled();
  expect(files.writeFile).not.toHaveBeenCalled();
});

it("allows 512 completion tokens and evaluates final content independently of reasoning", async () => {
  profile("1000");
  await import("../../scripts/live.ts");
  expect(requests).toEqual([expect.objectContaining({ max_tokens: 512 })]);
  expect(process.exitCode).toBeUndefined();
  expect(JSON.stringify(files.writeFile.mock.calls)).not.toContain("private reasoning fixture");
});

it("keeps reasoning-only output a failed live check instead of treating it as a final answer", async () => {
  profile("1000");
  finalContent = undefined;
  await import("../../scripts/live.ts");
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(files.writeFile.mock.lastCall![1])).toMatchObject({ hasNonemptyResponse: false });
  expect(JSON.stringify(files.writeFile.mock.calls)).not.toContain("private reasoning fixture");
});
