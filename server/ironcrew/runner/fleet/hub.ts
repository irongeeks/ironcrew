import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { TLSSocket } from "node:tls";
import type WebSocket from "ws";
import { z } from "zod";
import { redactValue } from "../../security/redaction.ts";
import { FleetStore, FLEET_LEASE_MS, FleetUnavailableError } from "./store.ts";
import { FleetChannel, channelFrameSchema, sendFrame } from "./channel.ts";
import { descriptorSchema, type RuntimeDescriptor, type FleetWorker } from "./types.ts";
import { RunnerRuntime } from "../runner-client.ts";
import type {
  AgentRuntime,
  RunInput,
  RunContext,
  RunEvent,
  RuntimeCapabilities,
  RuntimeHealth,
  AuthStatus,
} from "../../runtime/run-events.ts";

const readySchema = z
  .object({
    kind: z.literal("ready"),
    protocolToken: z.string().min(32).max(100),
    workspaceRoot: z.string().max(4096),
    runtimes: z.array(descriptorSchema).max(8),
  })
  .strict();
const heartbeatSchema = z
  .object({ kind: z.literal("heartbeat"), runtimes: z.array(descriptorSchema).max(8).optional() })
  .strict();
interface Link {
  ws: WebSocket;
  worker: FleetWorker;
  token: string;
  channels: Map<string, FleetChannel>;
  ready: boolean;
  lastHeartbeat: number;
}
export interface FleetHubOptions {
  db: DatabaseSync;
  companyId: string;
  broadcast?: (type: string, payload: unknown) => void;
  /** Tests only, direct loopback sockets. Never trust forwarding headers. */ allowInsecureLoopback?: boolean;
  now?: () => number;
}
export class FleetHub {
  readonly store: FleetStore;
  private readonly links = new Map<string, Link>();
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;
  constructor(private readonly options: FleetHubOptions) {
    this.now = options.now ?? Date.now;
    this.store = new FleetStore(options.db, options.companyId, this.now);
    this.store.recover();
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref();
  }
  runtime(type: string): AgentRuntime {
    return new FleetRuntime(this, type);
  }
  descriptors(type: string): RuntimeDescriptor[] {
    return [...this.links.values()]
      .filter((link) => link.ready && link.ws.readyState === 1 && this.now() - link.lastHeartbeat < FLEET_LEASE_MS)
      .flatMap((link) => this.store.get(link.worker.id)?.runtimes.filter((runtime) => runtime.type === type) ?? []);
  }
  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const encrypted = (req.socket as TLSSocket).encrypted;
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!encrypted && !(this.options.allowInsecureLoopback && loopback)) {
      ws.close(1008, "TLS required");
      return;
    }
    // Browsers cannot set this header. Cookies, query strings and Origin never enroll a worker.
    if (req.headers.origin || req.url?.includes("?")) {
      ws.close(1008, "Native runner headers required");
      return;
    }
    const authorization = req.headers.authorization;
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) {
      ws.close(1008, "Unauthorized");
      return;
    }
    let worker: FleetWorker | null = null;
    try {
      if (req.headers["x-ironcrew-fleet-mode"] === "enroll") {
        const enrollment = this.store.enroll(token);
        if (!enrollment) {
          ws.close(1008, "Unauthorized");
          return;
        }
        worker = enrollment.worker;
        sendFrame(ws, { kind: "enrolled", worker, credential: enrollment.credential });
      } else worker = this.store.authenticate(token);
      if (!worker) {
        ws.close(1008, "Unauthorized");
        return;
      }
      const previous = this.links.get(worker.id);
      if (previous) this.disconnect(previous);
      worker = this.store.connect(worker.id);
      const link: Link = { ws, worker, token: "", channels: new Map(), ready: false, lastHeartbeat: this.now() };
      this.links.set(worker.id, link);
      sendFrame(ws, { kind: "registered", worker });
      ws.on("message", (raw) => {
        try {
          if (raw.toString().length > 1_100_000) throw new Error("Frame too large");
          this.receive(link, JSON.parse(raw.toString()));
        } catch {
          this.disconnect(link);
        }
      });
      ws.on("close", () => this.disconnect(link));
      ws.on("error", () => this.disconnect(link));
      this.notifyChanged();
    } catch {
      ws.close(1011, "Fleet registration failed");
    }
  }
  private receive(link: Link, frame: unknown) {
    if (this.links.get(link.worker.id) !== link) throw new Error("Stale connection");
    const current = this.store.get(link.worker.id);
    if (
      !current ||
      current.state === "revoked" ||
      current.generation !== link.worker.generation ||
      (current.credentialExpiresAt ?? 0) <= this.now()
    )
      throw new Error("Revoked credential");
    const ready = readySchema.safeParse(frame);
    if (ready.success) {
      if (link.ready || ready.data.workspaceRoot !== current.workspaceRoot) throw new Error("Workspace mismatch");
      link.token = ready.data.protocolToken;
      link.ready = true;
      this.updateHeartbeat(link, ready.data.runtimes);
      sendFrame(link.ws, { kind: "ready-ok", generation: current.generation });
      this.notifyChanged();
      return;
    }
    if (!link.ready) throw new Error("Runner not ready");
    const heartbeat = heartbeatSchema.safeParse(frame);
    if (heartbeat.success) {
      this.updateHeartbeat(link, heartbeat.data.runtimes);
      sendFrame(link.ws, { kind: "heartbeat-ok" });
      const rotated = this.store.rotate(current.id);
      if (rotated) sendFrame(link.ws, { kind: "credential", ...rotated });
      return;
    }
    const packet = channelFrameSchema.parse(frame);
    if (packet.kind === "open") throw new Error("Runner cannot open jobs");
    const channel = link.channels.get(packet.channelId);
    if (!channel) return;
    if (packet.kind === "close") channel.disconnect();
    else channel.receive(packet.data);
  }
  private updateHeartbeat(link: Link, runtimes?: RuntimeDescriptor[]) {
    if (
      !this.store.heartbeat(
        link.worker.id,
        link.worker.generation,
        runtimes
          ? redactValue(runtimes.filter((runtime) => link.worker.runtimeTypes.includes(runtime.type)))
          : undefined,
      )
    )
      throw new Error("Stale worker");
    link.lastHeartbeat = this.now();
    if (runtimes) this.notifyChanged();
  }
  private sweep() {
    for (const link of this.links.values()) {
      const worker = this.store.get(link.worker.id);
      if (
        !worker ||
        worker.state === "revoked" ||
        this.now() - link.lastHeartbeat >= FLEET_LEASE_MS ||
        (worker.credentialExpiresAt ?? 0) <= this.now()
      )
        this.disconnect(link);
    }
  }
  private disconnect(link: Link) {
    for (const channel of [...link.channels.values()]) channel.disconnect();
    if (this.links.get(link.worker.id) === link) {
      this.links.delete(link.worker.id);
      this.store.disconnect(link.worker.id, link.worker.generation);
      this.notifyChanged();
    }
    link.ws.terminate();
  }
  revoke(id: string, actorId: string): FleetWorker {
    const worker = this.store.revoke(id, actorId);
    const link = this.links.get(id);
    if (link) this.disconnect(link);
    this.notifyChanged();
    return worker;
  }
  issue(id: string, actorId: string) {
    const enrollment = this.store.issue(id, 600, actorId);
    this.notifyChanged();
    return { worker: this.store.get(id)!, enrollment };
  }
  notifyChanged() {
    this.options.broadcast?.("crew.fleet.changed", { companyId: this.options.companyId });
  }
  reserve(type: string, context: RunContext, sessionRef?: string) {
    const reserved = this.store.reserve(
      type,
      context,
      new Set([...this.links].filter(([, link]) => link.ready).map(([id]) => id)),
      sessionRef,
    );
    const link = this.links.get(reserved.worker.id)!;
    const connect = async () => {
      if (this.links.get(link.worker.id) !== link || link.ws.readyState !== 1)
        throw new Error("Fleet lease disconnected");
      const id = randomUUID();
      const channel = new FleetChannel(id, link.ws, () => link.channels.delete(id));
      link.channels.set(id, channel);
      sendFrame(link.ws, { kind: "open", channelId: id });
      return channel;
    };
    return { runtime: new RunnerRuntime({ runtimeType: type, connect, token: link.token }), lease: reserved.lease };
  }
  close(): void {
    clearInterval(this.timer);
    for (const link of [...this.links.values()]) this.disconnect(link);
  }
}
class FleetRuntime implements AgentRuntime {
  readonly id: string;
  private active = new Map<string, RunnerRuntime>();
  constructor(
    private readonly hub: FleetHub,
    readonly type: string,
  ) {
    this.id = `fleet:${type}`;
  }
  async capabilities(): Promise<RuntimeCapabilities> {
    const items = this.hub.descriptors(this.type).filter((d) => d.health.healthy);
    if (!items.length)
      return {
        streaming: false,
        sessionResume: false,
        usageReporting: false,
        costReporting: false,
        toolCalls: false,
        subagents: false,
        defaultConcurrency: 1,
      };
    return {
      workspaceRequired: items.some((i) => i.capabilities.workspaceRequired !== false),
      streaming: items.every((i) => i.capabilities.streaming),
      usageReporting: items.every((i) => i.capabilities.usageReporting),
      costReporting: items.every((i) => i.capabilities.costReporting),
      toolCalls: items.every((i) => i.capabilities.toolCalls),
      subagents: items.every((i) => i.capabilities.subagents),
      sessionResume: items.every((i) => i.capabilities.sessionResume),
      defaultConcurrency: items.reduce((n, i) => n + i.capabilities.defaultConcurrency, 0),
    };
  }
  async healthCheck(): Promise<RuntimeHealth> {
    const items = this.hub.descriptors(this.type);
    return {
      healthy: items.some((d) => d.health.healthy),
      installed: items.some((d) => d.health.installed),
      detail: items.length ? `${items.length} verbundene Fleet-Laufzeiten` : "Kein berechtigter Fleet-Runner verbunden",
      checkedAt: Date.now(),
    };
  }
  async authStatus(): Promise<AuthStatus> {
    return (
      this.hub.descriptors(this.type).find((d) => d.health.healthy)?.auth ?? {
        authenticated: false,
        verification: "unverified",
        method: "none",
        detail: "Kein Fleet-Runner verbunden",
      }
    );
  }
  startRun(input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    return this.run(input, context, input.sessionRef);
  }
  resumeRun(sessionRef: string, input: RunInput, context: RunContext): AsyncIterable<RunEvent> {
    return this.run(input, context, sessionRef);
  }
  private async *run(input: RunInput, context: RunContext, sessionRef?: string): AsyncIterable<RunEvent> {
    let reserved: ReturnType<FleetHub["reserve"]>;
    try {
      reserved = this.hub.reserve(this.type, context, sessionRef);
    } catch (error) {
      if (!(error instanceof FleetUnavailableError)) throw error;
      yield {
        eventId: randomUUID(),
        companyId: context.companyId,
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        correlationId: context.correlationId,
        timestamp: Date.now(),
        seq: 0,
        type: "run.waiting",
        payload: { reason: "runner_unavailable", retryAt: error.retryAt, message: error.message },
        redaction: { redacted: false, rules: [] },
      };
      return;
    }
    const { runtime, lease } = reserved;
    this.active.set(context.runId, runtime);
    let completed = false;
    try {
      for await (const event of sessionRef
        ? runtime.resumeRun(sessionRef, input, context)
        : runtime.startRun(input, context)) {
        if (event.type === "run.completed" || event.type === "run.waiting") completed = true;
        yield event;
      }
    } finally {
      this.active.delete(context.runId);
      this.hub.store.release(lease.id, completed);
    }
  }
  async cancelRun(runId: string): Promise<void> {
    await this.active.get(runId)?.cancelRun(runId);
  }
}
