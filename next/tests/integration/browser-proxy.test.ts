import { expect, it } from "vitest";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createBrowserDenyProxy } from "../../packages/tools/browser-inspect.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
}

function request(port: number, target: number, clients: Set<Socket>, reset: boolean) {
  return new Promise<string>((resolve, reject) => {
    const client = connect({ port, host: "127.0.0.1" });
    clients.add(client);
    let response = "";
    client.setTimeout(3000, () => client.destroy(new Error("Proxy response deadline")));
    client.on("error", reject);
    client.once("connect", () =>
      client.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`),
    );
    client.on("data", (bytes) => {
      response += bytes.toString();
      if (response.includes("\r\n\r\n")) {
        if (reset) client.resetAndDestroy();
        else client.end();
      }
    });
    client.once("close", () => {
      clients.delete(client);
      resolve(response);
    });
  });
}

it("denies CONNECT before a real peer reset and keeps denying without connecting to the target", async () => {
  let targetConnections = 0;
  const target = createServer((socket) => {
    targetConnections++;
    socket.destroy();
  });
  const proxy = createBrowserDenyProxy();
  const clients = new Set<Socket>();
  try {
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy.server);
    // Observe close only: adding a test error listener would mask the production regression.
    const resetClosed = new Promise<void>((resolve) =>
      proxy.server.once("connect", (_req, socket) => socket.once("close", () => resolve())),
    );
    expect(await request(proxyPort, targetPort, clients, true)).toBe(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
    );
    await resetClosed;
    expect(await request(proxyPort, targetPort, clients, false)).toBe(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
    );
    expect(targetConnections).toBe(0);
  } finally {
    for (const client of clients) client.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

it("destroys an owned CONNECT socket when the inspection proxy closes", async () => {
  const proxy = createBrowserDenyProxy();
  let client: Socket | undefined;
  try {
    const port = await listen(proxy.server);
    const owned = new Promise<Duplex>((resolve) => proxy.server.once("connect", (_req, socket) => resolve(socket)));
    client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const response = new Promise<string>((resolve, reject) => {
      client!.on("error", reject);
      client!.once("data", (data) => resolve(data.toString()));
    });
    client.once("connect", () => client!.write("CONNECT example.invalid:443 HTTP/1.1\r\n\r\n"));
    const socket = await owned;
    expect(await response).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(false);
    await proxy.close();
    expect(socket.destroyed).toBe(true);
  } finally {
    client?.destroy();
    await proxy.close();
  }
});
