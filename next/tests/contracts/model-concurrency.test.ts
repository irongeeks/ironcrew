import { it, expect } from "vitest";
import { createServer } from "node:http";
import { OpenRouterClient } from "../../packages/runtime/src/openrouter.ts";
it("limits actual overlapping provider requests to two and releases slots on failed requests", async () => {
  let active = 0,
    maximum = 0,
    sequence = 0;
  const server = createServer((_req, res) => {
    active++;
    maximum = Math.max(maximum, active);
    const i = ++sequence;
    setTimeout(() => {
      active--;
      if (i === 1) {
        res.writeHead(503).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "fixture-" + i,
          choices: [{ message: { role: "assistant", content: "Fixture response" } }],
          usage: { cost: 0 },
        }),
      );
    }, 25);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new OpenRouterClient({
      baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port,
      testServer: true,
      secret: async () => "fixture-not-a-secret",
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        client.complete({
          model: "fixture",
          messages: [{ role: "user", content: "local fixture" }],
          tools: [],
          max_tokens: 4,
        }),
      ),
    );
    expect(maximum).toBe(2);
    expect(sequence).toBe(6);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("rechecks authority after waiting for a provider slot and emits no request for denied dispatch", async () => {
  let requests = 0,
    allowed = true;
  const server = createServer((_req, res) => {
    requests++;
    setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "generation-" + requests,
          choices: [{ message: { role: "assistant", content: "Fixture" } }],
          usage: { cost: 0 },
        }),
      );
    }, 35);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new OpenRouterClient({
      baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port,
      testServer: true,
      secret: async () => "fixture",
      maxConcurrent: 1,
    });
    const req = { model: "fixture", messages: [], tools: [], max_tokens: 4 };
    const first = client.complete(req);
    const second = client.complete(req, {
      beforeDispatch: async () => {
        if (!allowed) throw new Error("fixture authority revoked");
      },
    });
    const checked = expect(second).rejects.toMatchObject({ code: "model_dispatch_denied" });
    allowed = false;
    expect((await first).latencyMs).toBeGreaterThan(0);
    await checked;
    expect(requests).toBe(1);
    await client.complete(req);
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("checks authority after delayed credential resolution and releases the provider slot without sending", async () => {
  let requests = 0,
    allowed = true;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "fixture",
        choices: [{ message: { role: "assistant", content: "Fixture" } }],
        usage: { cost: 0 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new OpenRouterClient({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      testServer: true,
      maxConcurrent: 1,
      secret: async () => {
        await Promise.resolve();
        allowed = false;
        return "fixture-secret";
      },
    });
    const request = { model: "fixture", messages: [], tools: [], max_tokens: 4 };
    await expect(
      client.complete(request, {
        beforeDispatch: async () => {
          if (!allowed) throw new Error("credential-resolution revocation");
        },
      }),
    ).rejects.toMatchObject({ code: "model_dispatch_denied" });
    expect(requests).toBe(0);
    await client.complete(request);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
