/** Optional inbound mTLS endpoint for explicitly configured remote runners.
 * The existing token-authenticated run protocol and workspace checks run
 * only after mutual certificate authentication. No discovery or enrollment.
 */
import fs from "node:fs";
import tls from "node:tls";
import { RunnerServer, type RunnerServerOptions } from "./runner-server.ts";
import type { RunnerTlsListenerOptions } from "./transport.ts";
import { logger } from "../../observability/logger.ts";

export interface TlsRunnerDaemonOptions extends RunnerServerOptions {
  tls: RunnerTlsListenerOptions;
  /** Test injection only; production always uses Node's verified TLS server. */
  createServer?: typeof tls.createServer;
}

export class TlsRunnerDaemon {
  private readonly server: RunnerServer;
  private listener: tls.Server | null = null;
  constructor(private readonly opts: TlsRunnerDaemonOptions) {
    this.server = new RunnerServer(opts);
  }
  get address() {
    return this.listener?.address() ?? null;
  }
  async listen(): Promise<void> {
    if (this.listener) throw new Error("Runner TLS listener already started.");
    const cfg = this.opts.tls;
    const listener = (this.opts.createServer ?? tls.createServer)(
      {
        cert: fs.readFileSync(cfg.certFile),
        key: fs.readFileSync(cfg.keyFile),
        ca: fs.readFileSync(cfg.clientCaFile),
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        handshakeTimeout: 15_000,
      },
      (socket) => {
        if (!socket.authorized) {
          socket.destroy();
          return;
        }
        socket.setEncoding("utf-8");
        this.server.handleConnection(socket);
      },
    );
    listener.on("tlsClientError", () => logger.warn("Runner refused an unauthenticated TLS client."));
    listener.on("error", () => logger.error("Runner TLS listener error."));
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(cfg.port, cfg.host, () => {
          listener.removeListener("error", reject);
          resolve();
        });
      });
      this.listener = listener;
    } catch (err) {
      listener.close();
      throw err;
    }
  }
  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    if (!listener) return;
    this.server.closeConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await this.opts.mcp?.closeAll();
  }
}
