import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import type { AgentRuntime } from "../../runtime/run-events.ts";
import { RunnerServer } from "../runner-server.ts";
import { decodeClientMessage, LineDecoder } from "../protocol.ts";
import { FleetChannel, channelFrameSchema, sendFrame } from "./channel.ts";
import { permitsContext, type RuntimeDescriptor } from "./types.ts";

const workerSchema = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  workspaceRoot: z.string().min(2),
  runtimeTypes: z.array(z.string()).max(8),
  projectIds: z.array(z.string()).max(100),
  allowUnscoped: z.boolean(),
});
type WorkerScope = z.infer<typeof workerSchema>;
const credentialSchema = z
  .object({
    worker: workerSchema,
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().positive(),
  })
  .strict();
export interface OutboundRunnerOptions {
  url: string;
  credentialFile: string;
  enrollmentToken?: string;
  workspaceRoot: string;
  runtimes: AgentRuntime[];
  ca?: Buffer;
  allowInsecureLoopback?: boolean;
  heartbeatMs?: number;
  usageAckTimeoutMs?: number;
  onStatus?: (status: "connected" | "disconnected" | "reconnecting") => void;
}
/** Runner opens the only network connection; no listening port or OAuth transfer. */
export class OutboundRunner {
  private readonly server: RunnerServer;
  private readonly protocolToken = randomBytes(32).toString("base64url");
  private readonly url: URL;
  private credential: z.infer<typeof credentialSchema> | null = null;
  private ws: WebSocket | null = null;
  private channels = new Map<string, FleetChannel>();
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private stopped = false;
  private attempt = 0;
  private scope: WorkerScope | null = null;
  private credentialFile = "";
  constructor(private readonly options: OutboundRunnerOptions) {
    this.url = new URL(options.url);
    if (
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== "/api/crew/fleet/connect"
    )
      throw new Error("Fleet URL must use /api/crew/fleet/connect without credentials or query");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname);
    if (this.url.protocol !== "wss:" && !(options.allowInsecureLoopback && loopback && this.url.protocol === "ws:"))
      throw new Error("Outbound fleet requires WSS");
    if (!path.isAbsolute(options.credentialFile)) throw new Error("Fleet credential file must be absolute");
    this.server = new RunnerServer({
      runtimes: options.runtimes,
      token: this.protocolToken,
      workspaceRoot: options.workspaceRoot,
      usageAckTimeoutMs: options.usageAckTimeoutMs,
    });
  }
  async start(): Promise<void> {
    const configuredDirectory = path.dirname(this.options.credentialFile);
    await fs.mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
    // macOS exposes /var and /tmp through system symlinks. Resolve the parent
    // once, then keep all file operations under that owned canonical directory.
    const directory = await fs.realpath(configuredDirectory);
    const parent = await fs.stat(directory);
    if ((parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error("Fleet credential directory must be owned and not writable by others");
    this.credentialFile = path.join(directory, path.basename(this.options.credentialFile));
    try {
      const file = await fs.open(this.credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 32_768 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("Fleet credential file must be private and bounded");
        this.credential = credentialSchema.parse(JSON.parse(await file.readFile("utf8")));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!this.credential && !this.options.enrollmentToken)
      throw new Error("Fleet enrollment token or existing credential file required");
    try {
      await this.connect();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async save(worker: WorkerScope, credential: string, expiresAt: number) {
    const next = credentialSchema.parse({ worker, credential, expiresAt });
    const dir = path.dirname(this.credentialFile);
    if ((await fs.realpath(dir)) !== dir) throw new Error("Fleet credential directory changed after startup");
    const parent = await fs.stat(dir);
    if ((parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error("Fleet credential directory must be owned and not writable by others");
    const temporary = `${this.credentialFile}.${randomBytes(8).toString("hex")}.tmp`;
    const file = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, this.credentialFile);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const directory = await fs.open(dir, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.credential = next;
  }
  private async descriptors(): Promise<RuntimeDescriptor[]> {
    return Promise.all(
      this.options.runtimes
        .filter((runtime) => this.scope?.runtimeTypes.includes(runtime.type))
        .map(async (runtime): Promise<RuntimeDescriptor> => {
          let timer: NodeJS.Timeout | undefined;
          try {
            const [capabilities, health, auth] = await Promise.race([
              Promise.all([runtime.capabilities(), runtime.healthCheck(), runtime.authStatus()]),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Runtime probe timed out")), 10_000);
                timer.unref();
              }),
            ]);
            return { type: runtime.type, capabilities, health, auth };
          } catch {
            return {
              type: runtime.type,
              capabilities: {
                streaming: false,
                sessionResume: false,
                usageReporting: false,
                costReporting: false,
                toolCalls: false,
                subagents: false,
                defaultConcurrency: 1,
              },
              health: {
                healthy: false,
                installed: false,
                checkedAt: Date.now(),
                detail: "Laufzeitprüfung fehlgeschlagen oder Zeitlimit überschritten",
              },
              auth: {
                authenticated: false,
                verification: "unverified",
                method: "none",
                detail: "Laufzeitprüfung nicht verfügbar",
              },
            };
          } finally {
            clearTimeout(timer);
          }
        }),
    );
  }
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        reject(new Error("Outbound runner stopped"));
        return;
      }
      const enroll = !this.credential;
      const token = this.credential?.credential ?? this.options.enrollmentToken;
      const ws = new WebSocket(this.url, {
        headers: { authorization: `Bearer ${token}`, "x-ironcrew-fleet-mode": enroll ? "enroll" : "connect" },
        ca: this.options.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        handshakeTimeout: 15_000,
        maxPayload: 1_100_000,
        followRedirects: false,
      });
      this.ws = ws;
      let ready = false,
        settled = false;
      const timer = setTimeout(() => {
        ws.terminate();
        if (!settled) {
          settled = true;
          reject(new Error("Fleet registration timed out"));
        }
      }, 15_000);
      timer.unref();
      let lastReply = Date.now();
      let queued = 0;
      let processing = Promise.resolve();
      ws.on("message", (raw) => {
        if (++queued > 256) {
          ws.terminate();
          return;
        }
        processing = processing
          .then(async () => {
            lastReply = Date.now();
            const frame: unknown = JSON.parse(raw.toString());
            const kind = z.object({ kind: z.string() }).parse(frame).kind;
            if (kind === "enrolled") {
              if (!enroll) throw new Error("Unexpected enrollment");
              const value = z
                .object({
                  worker: workerSchema.extend({ credentialExpiresAt: z.number() }),
                  credential: credentialSchema.shape.credential,
                })
                .parse(frame);
              this.scope = value.worker;
              await this.save(value.worker, value.credential, value.worker.credentialExpiresAt);
              this.options.enrollmentToken = undefined;
              return;
            }
            if (kind === "registered") {
              const worker = workerSchema.parse(z.object({ worker: workerSchema }).parse(frame).worker);
              if (
                !this.credential ||
                worker.id !== this.credential.worker.id ||
                JSON.stringify(worker) !== JSON.stringify(this.credential.worker)
              )
                throw new Error("Worker scope changed; re-enrollment required");
              if (worker.workspaceRoot !== path.resolve(this.options.workspaceRoot))
                throw new Error("Assigned workspace does not match local root");
              this.scope = worker;
              sendFrame(ws, {
                kind: "ready",
                protocolToken: this.protocolToken,
                workspaceRoot: worker.workspaceRoot,
                runtimes: await this.descriptors(),
              });
              return;
            }
            if (kind === "ready-ok") {
              if (ready) throw new Error("Duplicate ready");
              ready = true;
              settled = true;
              clearTimeout(timer);
              this.attempt = 0;
              this.options.onStatus?.("connected");
              let ticks = 0,
                busy = false;
              this.heartbeat = setInterval(() => {
                if (Date.now() - lastReply >= 45_000) {
                  ws.terminate();
                  return;
                }
                if (busy) return;
                busy = true;
                void (async () => {
                  try {
                    sendFrame(ws, {
                      kind: "heartbeat",
                      ...(++ticks % 4 === 0 ? { runtimes: await this.descriptors() } : {}),
                    });
                  } catch {
                    ws.terminate();
                  } finally {
                    busy = false;
                  }
                })();
              }, this.options.heartbeatMs ?? 15_000);
              this.heartbeat.unref();
              resolve();
              return;
            }
            if (kind === "heartbeat-ok") {
              if (!ready) throw new Error("Unregistered heartbeat");
              return;
            }
            if (kind === "credential") {
              if (!ready || !this.scope) throw new Error("Unregistered credential");
              const value = z
                .object({ credential: credentialSchema.shape.credential, expiresAt: z.number() })
                .parse(frame);
              await this.save(this.scope, value.credential, value.expiresAt);
              return;
            }
            if (!ready) throw new Error("Fleet not ready");
            const packet = channelFrameSchema.parse(frame);
            if (packet.kind === "open") {
              if (this.channels.size >= 128 || this.channels.has(packet.channelId))
                throw new Error("Channel limit or duplicate");
              const channel = new FleetChannel(packet.channelId, ws, () => this.channels.delete(packet.channelId));
              this.channels.set(packet.channelId, channel);
              // Validate owner-assigned scopes before the existing authenticated v2 server sees any job.
              const decoder = new LineDecoder();
              const receive = channel.receive.bind(channel);
              channel.receive = (data: string) => {
                for (const line of decoder.push(data)) {
                  const message = decodeClientMessage(line);
                  if (message.kind.startsWith("mcp-")) throw new Error("Fleet MCP access is not granted");
                  if (message.kind === "start" || message.kind === "resume") {
                    if (!this.scope || !permitsContext(this.scope, message.runtimeType, message.context))
                      throw new Error("Job outside enrolled scope");
                  }
                  receive(`${line}\n`);
                }
              };
              this.server.handleConnection(channel);
              return;
            }
            const channel = this.channels.get(packet.channelId);
            if (!channel) return;
            if (packet.kind === "close") channel.disconnect();
            else channel.receive(packet.data);
          })
          .catch(() => ws.terminate())
          .finally(() => {
            queued--;
          });
      });
      ws.on("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Fleet connection failed"));
        }
      });
      ws.on("close", (code) => {
        if (code === 1008) this.stopped = true;
        clearTimeout(timer);
        clearInterval(this.heartbeat);
        for (const channel of [...this.channels.values()]) channel.disconnect();
        this.options.onStatus?.("disconnected");
        if (!settled) {
          settled = true;
          reject(new Error("Fleet registration rejected"));
        }
        if (!this.stopped && ready) this.scheduleReconnect();
      });
    });
  }
  private scheduleReconnect() {
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6)) * (0.8 + Math.random() * 0.4);
    this.options.onStatus?.("reconnecting");
    this.reconnect = setTimeout(() => {
      void this.connect().catch(() => {
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
    this.reconnect.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnect);
    this.ws?.terminate();
    for (const channel of [...this.channels.values()]) channel.disconnect();
    this.server.closeConnections();
  }
}
