import { it, expect } from "vitest";
import { createServer } from "node:http";
import { OpenRouterClient } from "../../packages/runtime/src/openrouter.ts";
it("buffers stream and refuses incomplete tool arguments without executing anything", async () => {
  let complete = false;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(
      "data: " +
        JSON.stringify({
          id: "gen-1",
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call-1", function: { name: "workspace__read", arguments: '{"path":' } }],
              },
            },
          ],
        }) +
        "\n\n",
    );
    if (complete) {
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
            usage: { cost: 0.001 },
          }) +
          "\n\n",
      );
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const client = new OpenRouterClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    testServer: true,
    secret: async () => "fixture",
  });
  try {
    await expect(client.complete({ model: "fixture", messages: [], tools: [], max_tokens: 1 })).rejects.toThrow(
      "model_interrupted",
    );
    complete = true;
    const response = await client.complete({ model: "fixture", messages: [], tools: [], max_tokens: 1 });
    expect(response.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.txt"}');
    expect(response.costUsdMicros).toBe("1000");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("reports safe HTTP rejection diagnostics and suggests free routing without a fallback", async () => {
  const { vi } = await import("vitest");
  const { ModelRequestRejected } = await import("../../packages/runtime/src/openrouter.ts");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const fetch = vi.spyOn(globalThis, "fetch");
  const client = new OpenRouterClient({ secret: async () => "private-key" });
  try {
    for (const status of [400, 401, 402, 403, 404, 422, 429, 500]) {
      fetch.mockResolvedValueOnce(new Response("private-provider-payload", { status }));
      let failure: unknown;
      try {
        await client.complete({ model: "vendor/model:free", messages: [], tools: [], max_tokens: 1 });
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof ModelRequestRejected).toBe(status !== 500);
      expect(warning).toHaveBeenLastCalledWith(
        "IronCrew model call failed",
        expect.objectContaining({ phase: "http", status, modelId: "vendor/model:free" }),
      );
      if (status === 404) expect(failure).toMatchObject({ code: "model_free_endpoint_unavailable" });
    }
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-key|private-provider-payload/);
    expect(JSON.stringify(warning.mock.calls)).toContain("openrouter/free");
  } finally {
    warning.mockRestore();
    fetch.mockRestore();
  }
});

it("does not dispatch when request timeout expires during the final authorization check", async () => {
  const { vi } = await import("vitest");
  const fetch = vi.spyOn(globalThis, "fetch");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const client = new OpenRouterClient({ secret: async () => "key", timeoutMs: 1 });
  try {
    await expect(
      client.complete(
        { model: "fixture", messages: [], tools: [], max_tokens: 1 },
        { beforeDispatch: () => new Promise((resolve) => setTimeout(resolve, 10)) },
      ),
    ).rejects.toMatchObject({ code: "model_dispatch_denied" });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    warn.mockRestore();
  }
});
