/**
 * IronCrew — the runner daemon's process.
 *
 * Everything policy-shaped lives in runner-server.ts; this file is only the
 * plumbing that gives it a Unix socket and a clean life cycle. Kept separate
 * so the server logic stays testable without binding anything.
 *
 * THE SOCKET'S PERMISSIONS ARE THE ACCESS CONTROL
 *
 * `0o660` and a group both accounts share: the runner user owns it, the
 * IronCrew service user can reach it through the group, and nothing else on
 * the machine can. That is the whole isolation — a TCP port on localhost
 * would be reachable by every process on the box, including anything an
 * agent itself starts, which would make this daemon decorative.
 *
 * A stale socket file from an unclean shutdown is removed at startup, but
 * only after checking that nothing is listening on it. Removing a live
 * socket would silently steal traffic from a running daemon.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { logger } from "../../observability/logger.ts";
import { RunnerServer, type RunnerServerOptions } from "./runner-server.ts";

const log = logger.child({ module: "ironcrew-runner" });

export interface RunnerDaemonOptions extends RunnerServerOptions {
  socketPath: string;
  /** Defaults to 0o660: owner and group, never world. */
  socketMode?: number;
}

export class RunnerDaemon {
  private readonly server: RunnerServer;
  private readonly socketPath: string;
  private readonly socketMode: number;
  private listener: net.Server | null = null;

  constructor(private readonly opts: RunnerDaemonOptions) {
    this.server = new RunnerServer(opts);
    this.socketPath = path.resolve(opts.socketPath);
    this.socketMode = opts.socketMode ?? 0o660;
  }

  /**
   * Whether a socket file at this path is a leftover rather than a live one.
   *
   * Connecting is the only honest test: a file existing proves nothing after
   * a crash, and removing a socket another daemon is serving would steal its
   * traffic silently.
   */
  private static async isStale(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.connect(socketPath);
      const done = (stale: boolean) => {
        probe.destroy();
        resolve(stale);
      };
      probe.once("connect", () => done(false));
      probe.once("error", () => done(true));
      probe.setTimeout(1000, () => done(true));
    });
  }

  async listen(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      if (!(await RunnerDaemon.isStale(this.socketPath))) {
        throw new Error(`Another runner is already listening on ${this.socketPath}.`);
      }
      log.warn({ socketPath: this.socketPath }, "removing a stale socket from an unclean shutdown");
      fs.rmSync(this.socketPath);
    }

    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    const listener = net.createServer((socket) => {
      socket.setEncoding("utf-8");
      this.server.handleConnection(socket);
    });
    listener.on("error", (err) => log.error({ err: err.message }, "runner listener error"));

    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(this.socketPath, () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });

    // After listen, because the file does not exist before it.
    fs.chmodSync(this.socketPath, this.socketMode);
    this.listener = listener;

    log.info(
      {
        socketPath: this.socketPath,
        mode: this.socketMode.toString(8),
        runtimes: this.server.runtimeTypes,
        workspaceRoot: this.opts.workspaceRoot,
      },
      "runner listening",
    );
  }

  async close(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    if (!listener) return;

    await new Promise<void>((resolve) => listener.close(() => resolve()));
    // The socket file outlives the listener; leaving it behind would make the
    // next start think another daemon is running until it probes.
    if (fs.existsSync(this.socketPath)) {
      try {
        fs.rmSync(this.socketPath);
      } catch {
        // Best effort: the stale check on the next start handles it.
      }
    }
    log.info("runner stopped");
  }
}
