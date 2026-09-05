import https from "node:https";
import fs from "node:fs/promises";
import { WebSocketServer } from "ws";
import type { FleetHub } from "./hub.ts";

/** Optional dedicated TLS endpoint, including when the web UI uses a reverse proxy. */
export async function startFleetListener(
  hub: FleetHub,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ close(): Promise<void> } | null> {
  if (!env.IRONCREW_FLEET_PORT) return null;
  const port = Number(env.IRONCREW_FLEET_PORT);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !env.IRONCREW_FLEET_CERT_FILE ||
    !env.IRONCREW_FLEET_KEY_FILE
  )
    throw new Error("Fleet listener needs valid PORT, CERT_FILE and KEY_FILE");
  const [cert, key] = await Promise.all([
    fs.readFile(env.IRONCREW_FLEET_CERT_FILE),
    fs.readFile(env.IRONCREW_FLEET_KEY_FILE),
  ]);
  const server = https.createServer({ cert, key, minVersion: "TLSv1.3" }, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_100_000, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/crew/fleet/connect") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws, req));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, env.IRONCREW_FLEET_HOST ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
