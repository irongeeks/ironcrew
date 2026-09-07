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
