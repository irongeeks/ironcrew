import { RemoteExecutionWorker } from "../../packages/tools/remote-execution/worker.ts";
import {
  remoteControlSchema,
  attestationSchema,
  assertControlSize,
  type RemoteWorkerMessage,
} from "../../packages/tools/remote-execution/protocol.ts";
import type { ExecutionPort, Attestation } from "../../packages/tools/isolation/types.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  controlMessageSchema,
  type ControlMessage,
  type Json,
  type ToolAction,
  type WorkerMessage,
} from "../../packages/contracts/src/index.ts";
import { assert } from "../../packages/domain/src/index.ts";
import { ExecutionJournal } from "../../packages/tools/journal.ts";
export interface WorkerClientOptions {
  url: string;
  workerId: string;
  token: string;
  generation: number;
  capabilities: string[];
  directory: string;
  ca?: string | Buffer;
  executionPort?: ExecutionPort;
  attestation?: Attestation;
  execute: (action: ToolAction, signal: AbortSignal) => Promise<Json>;
  maxConcurrent?: number;
  reconnectDelayMs?: number;
}
/** A durable outbound mailbox is retained until the central service commits and ACKs. */
export class WorkerClient {
  private options: WorkerClientOptions;
  private socket: WebSocket | undefined;
  private sequence = 0;
  private outgoing = Promise.resolve();
  private incoming = Promise.resolve();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = new Map<string, AbortController>();
  private journal: ExecutionJournal;
  private remote?: RemoteExecutionWorker;
  constructor(options: WorkerClientOptions) {
    assert(new URL(options.url).protocol === "wss:", "tls_required", 400);
    this.options = options;
    if (options.executionPort)
      this.remote = new RemoteExecutionWorker({
        directory: options.directory,
        url: options.url,
        ca: options.ca,
        port: options.executionPort,
        send: (payload) => this.send(payload),
        maxConcurrent: options.maxConcurrent ?? 1,
      });
    this.journal = new ExecutionJournal(path.join(options.directory, "journal"));
  }
  private get mailbox() {
    return path.join(this.options.directory, "mailbox");
  }
  private async atomicFile(file: string, data: unknown) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID() + ".tmp",
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  }
  async start(): Promise<void> {
    await mkdir(this.mailbox, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(path.join(this.options.directory, "sequence.json"), "utf8")) as {
        generation: number;
        sequence: number;
      };
      assert(state.generation === this.options.generation, "worker_generation_changed_requires_new_state");
      this.sequence = state.sequence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.connect();
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url, {
        ca: this.options.ca,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "x-worker-id": this.options.workerId,
          "x-worker-generation": String(this.options.generation),
        },
        maxPayload: 1024 * 1024,
      });
      this.socket = ws;
      let opened = false;
      ws.once("open", () => {
        opened = true;
        void this.onOpen().then(resolve, reject);
      });
      ws.on("message", (raw) => {
        this.incoming = this.incoming
          .then(() => this.receive(JSON.parse(raw.toString())))
          .catch(() => {
            ws.close(4003, "Invalid control message");
          });
      });
      ws.once("error", (error) => {
        if (!opened) reject(error);
      });
      ws.on("error", () => {});
      ws.on("close", (code) => {
        if (code === 4001 || code === 4002) this.remote?.stop();
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            void this.connect().catch(() => {});
          }, this.options.reconnectDelayMs ?? 1000);
          this.timer.unref();
        }
      });
    });
  }
  private async onOpen() {
    const files = await readdir(this.mailbox);
    const pending: (WorkerMessage | RemoteWorkerMessage)[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")))
      pending.push(JSON.parse(await readFile(path.join(this.mailbox, file), "utf8")) as WorkerMessage);
    pending.sort((a, b) => a.sequence - b.sequence);
    for (const message of pending) {
      assert(message.generation === this.options.generation, "stale_mailbox_generation");
      this.socket!.send(JSON.stringify(message));
    }
    await this.send({
      type: "hello",
      capabilities: this.options.capabilities,
      appVersion: "0.4.0-dev.0",
      maxConcurrent: this.options.maxConcurrent ?? 1,
    });
    if (this.options.attestation && this.remote)
      await this.send({ type: "remote.hello", attestation: attestationSchema.parse(this.options.attestation) });
  }
  private async send(payload: WorkerMessage["payload"] | RemoteWorkerMessage["payload"]): Promise<void> {
    this.outgoing = this.outgoing.then(async () => {
      const message = {
        protocolVersion: 1 as const,
        messageId: randomUUID(),
        workerId: this.options.workerId,
        generation: this.options.generation,
        sequence: ++this.sequence,
        sentAt: new Date().toISOString(),
        payload,
      };
      assertControlSize(message);
      await this.atomicFile(path.join(this.options.directory, "sequence.json"), {
        generation: this.options.generation,
        sequence: this.sequence,
      });
      await this.atomicFile(path.join(this.mailbox, message.messageId + ".json"), message);
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    });
    await this.outgoing;
  }
  private async receive(input: unknown) {
    const remote = remoteControlSchema.safeParse(input);
    if (remote.success) {
      assert(
        remote.data.workerId === this.options.workerId && remote.data.generation === this.options.generation,
        "worker_fenced",
      );
      assert(this.remote, "isolation_profile_unverified");
      await this.remote.receive(remote.data.payload);
      return;
    }
    const message = controlMessageSchema.parse(input) as ControlMessage;
    assert(
      message.workerId === this.options.workerId && message.generation === this.options.generation,
      "worker_fenced",
    );
    const payload = message.payload;
    if (payload.type === "ack") {
      await unlink(path.join(this.mailbox, payload.acknowledgedMessageId + ".json")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      return;
    }
    if (payload.type === "cancel") {
      this.active.get(payload.actionId)?.abort(new Error(payload.reason));
      return;
    }
    if (payload.type === "reconcile") return;
    assert(Date.parse(payload.expiresAt) > Date.now(), "lease_expired");
    assert(this.options.capabilities.includes(payload.action.toolId), "capability_denied");
    if (this.active.has(payload.action.id)) return;
    assert(this.active.size < (this.options.maxConcurrent ?? 1), "worker_capacity");
    const controller = new AbortController();
    this.active.set(payload.action.id, controller);
    await this.send({ type: "started", actionId: payload.action.id, leaseId: payload.leaseId });
    void this.execute(payload, controller).catch(() => {
      this.socket?.close(4004, "Execution receipt failed");
    });
  }
  private async execute(
    payload: Extract<ControlMessage["payload"], { type: "dispatch" }>,
    controller: AbortController,
  ) {
    try {
      const result = await this.journal.execute(payload.action.id, payload.action.argumentsSha256, () =>
        this.options.execute(payload.action, controller.signal),
      );
      await this.send({
        type: "result",
        actionId: payload.action.id,
        leaseId: payload.leaseId,
        status: result.status,
        data: result.data as Json,
        resultSha256: result.resultSha256,
        evidenceRefs: [],
      });
    } finally {
      this.active.delete(payload.action.id);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.remote?.stop();
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.active.values()) controller.abort();
    this.socket?.terminate();
    await this.outgoing;
  }
}
