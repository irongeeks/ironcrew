import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { describe, expect, it } from "vitest";

async function listen(server: http.Server, host: string, port = 0, ipv6Only = false): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("Supertest listener isolation", () => {
  it("reaches the requested IPv6 listener when an IPv4 server owns the same port", async () => {
    let foreignRequests = 0;
    const intended = http.createServer((_req, res) => res.end("intended"));
    const foreign = http.createServer((_req, res) => {
      foreignRequests++;
      res.statusCode = 404;
      res.end("foreign listener");
    });
    try {
      const port = await listen(intended, "::", 0, true);
      await listen(foreign, "127.0.0.1", port);
      const response = await request(intended).get("/fixture");
      expect(foreignRequests, "A request for an IPv6 fixture must never reach the IPv4 fixture").toBe(0);
      expect(response.status).toBe(200);
      expect(response.text).toBe("intended");
    } finally {
      await Promise.all([close(intended), close(foreign)]);
    }
  });

  it.each(["::1", "127.0.0.1", "0.0.0.0"])("reaches a server bound to %s", async (host) => {
    const server = http.createServer((_req, res) => res.end(host));
    try {
      await listen(server, host);
      const response = await request(server).get("/fixture").expect(200);
      expect(response.text).toBe(host);
    } finally {
      await close(server);
    }
  });
});
