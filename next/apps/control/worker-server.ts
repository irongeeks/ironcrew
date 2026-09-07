import { RemoteExecutionServer } from "../../packages/tools/remote-execution/server.ts";
import {
  remoteWorkerSchema,
  assertControlSize,
  type RemoteControlMessage,
} from "../../packages/tools/remote-execution/protocol.ts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  workerMessageSchema,
  toolActionSchema,
  type ControlMessage,
  type Scope,
  type ToolAction,
  type WorkerMessage,
} from "../../packages/contracts/src/index.ts";
import { assert, sha256 } from "../../packages/domain/src/index.ts";
import { Repository, type AuthorizationInput, type Document } from "../../packages/persistence/src/index.ts";

export interface WorkerIdentity {
  id: string;
  name: string;
  credentialHash: string;
  generation: number;
  capabilities: string[];
  maxConcurrent: number;
  sequence: number;
  revoked: boolean;
  enrolledAt: string;
  lastSeenAt?: string;
}
export interface WorkerLease {
  id: string;
  workerId: string;
  generation: number;
  actionId: string;
  scope: Scope;
  expiresAt: string;
  state: "active" | "completed" | "expired";
  lastSequence: number;
}
export interface Enrollment {
  workerId: string;
  token: string;
  generation: number;
}
interface Session {
  socket: WebSocket;
  workerId: string;
  generation: number;
  sequence: number;
  outgoing: number;
  chain: Promise<void>;
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const equalToken = (token: string, expected: string) => {
  const a = Buffer.from(hashToken(token), "hex"),
    b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const wireHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Only mount on HTTPS. Native workers always initiate the authenticated connection. */
export class WorkerServer {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private sessions = new Map<string, Session>();
  private leases = new Map<string, WorkerLease>();
  private dispatchQueues = new Map<string, Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private options: { server: HttpsServer; repo: Repository; scope: Scope; path?: string; directory?: string };
  private remote: RemoteExecutionServer;
  private constructor(options: {
    server: HttpsServer;
    repo: Repository;
    scope: Scope;
    path?: string;
    directory?: string;
  }) {
    this.options = options;
    this.remote = new RemoteExecutionServer(
      options.repo,
      options.scope,
      {
        lock: (id, operation) => this.lockDispatch(id, operation),
        legacyActive: (id) => [...this.leases.values()].filter((l) => l.workerId === id && l.state === "active").length,
        identity: async (id) => (await this.identity(id)).data,
        online: (id) => this.sessions.get(id)?.socket.readyState === WebSocket.OPEN,
        send: (id, payload) => {
          const session = this.sessions.get(id);
          if (session) this.send(session, payload);
        },
      },
      options.directory,
    );
  }
  static async create(options: {
    server: HttpsServer;
    repo: Repository;
    scope: Scope;
    path?: string;
    directory?: string;
  }): Promise<WorkerServer> {
    const result = new WorkerServer(options);
    await result.restore();
    options.server.on("upgrade", result.upgrade);
    result.timer = setInterval(() => {
      void result.reconcileExpired().catch(() => {});
    }, 1000);
    result.timer.unref();
    return result;
  }
  private async restore() {
    const scopes = new Map<string, Scope>();
    scopes.set(sha256(this.options.scope), this.options.scope);
    for (const order of await this.options.repo.listAllOrders(this.options.scope.companyId))
      scopes.set(sha256(order.scope), order.scope);
    for (const scope of scopes.values())
      for (const lease of await this.options.repo.listDocuments<WorkerLease>(scope, "worker_lease"))
        this.leases.set(lease.id, lease.data);
  }
  async enroll(name: string, capabilities: string[], maxConcurrent = 1): Promise<Enrollment> {
    assert(
      name.trim() &&
        capabilities.length > 0 &&
        Number.isSafeInteger(maxConcurrent) &&
        maxConcurrent > 0 &&
        maxConcurrent <= 16,
      "invalid_worker",
      400,
    );
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const identity: WorkerIdentity = {
      id,
      name,
      capabilities: [...new Set(capabilities)],
      credentialHash: hashToken(token),
      generation: 1,
      maxConcurrent,
      sequence: 0,
      revoked: false,
      enrolledAt: new Date().toISOString(),
    };
    await this.options.repo.putDocument(this.options.scope, "worker", id, identity, { immutable: false });
    return { workerId: id, token, generation: 1 };
  }
  async rotate(workerId: string): Promise<Enrollment> {
    const prior = await this.identity(workerId),
      token = randomBytes(32).toString("base64url");
    await this.options.repo.putDocument(
      this.options.scope,
      "worker",
      workerId,
      {
        ...prior.data,
        credentialHash: hashToken(token),
        generation: prior.data.generation + 1,
        sequence: 0,
        revoked: false,
      },
      { expectedRevision: prior.revision },
    );
    this.sessions.get(workerId)?.socket.close(4001, "Credential rotated");
    await this.expireWorker(workerId);
    await this.remote.cancelWorker(workerId);
    return { workerId, token, generation: prior.data.generation + 1 };
  }
  async revoke(workerId: string): Promise<void> {
    const prior = await this.identity(workerId);
    await this.options.repo.putDocument(
      this.options.scope,
      "worker",
      workerId,
      { ...prior.data, revoked: true, generation: prior.data.generation + 1 },
      { expectedRevision: prior.revision },
    );
    this.sessions.get(workerId)?.socket.close(4001, "Worker revoked");
    await this.expireWorker(workerId);
    await this.remote.cancelWorker(workerId);
  }
  private async identity(id: string): Promise<Document<WorkerIdentity>> {
    const result = await this.options.repo.getDocument<WorkerIdentity>(this.options.scope, "worker", id);
    assert(result, "worker_not_found", 404);
    return result;
  }
  private upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    if (new URL(request.url ?? "/", "https://localhost").pathname !== (this.options.path ?? "/api/v1/workers/connect"))
      return;
    void this.authenticate(request)
      .then((identity) => {
        if (this.closed) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          const prior = this.sessions.get(identity.id);
          prior?.socket.close(4002, "Reconnected");
          const session: Session = {
            socket: ws,
            workerId: identity.id,
            generation: identity.generation,
            sequence: identity.sequence,
            outgoing: 0,
            chain: Promise.resolve(),
          };
          this.sessions.set(identity.id, session);
          ws.on("message", (data) => {
            session.chain = session.chain
              .then(() => this.receive(session, JSON.parse(data.toString())))
              .catch(() => {
                ws.close(4003, "Invalid worker message");
              });
          });
          ws.on("error", () => {});
          ws.on("close", () => {
            if (this.sessions.get(identity.id) === session) this.sessions.delete(identity.id);
          });
          this.wss.emit("connection", ws, request);
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });
  };
  private async authenticate(request: IncomingMessage): Promise<WorkerIdentity> {
    assert((request.socket as import("node:tls").TLSSocket).encrypted, "tls_required", 403);
    const id = String(request.headers["x-worker-id"] ?? ""),
      generation = Number(request.headers["x-worker-generation"]);
    const authorization = request.headers.authorization ?? "";
    assert(authorization.startsWith("Bearer "), "worker_unauthorized", 401);
    const worker = (await this.identity(id)).data;
    assert(
      !worker.revoked && worker.generation === generation && equalToken(authorization.slice(7), worker.credentialHash),
      "worker_unauthorized",
      401,
    );
    return worker;
  }
  private send(session: Session, payload: ControlMessage["payload"] | RemoteControlMessage["payload"]) {
    const message = {
      protocolVersion: 1,
      messageId: randomUUID(),
      workerId: session.workerId,
      generation: session.generation,
      sequence: ++session.outgoing,
      sentAt: new Date().toISOString(),
      payload,
    };
    assertControlSize(message);
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  }
  private async receive(session: Session, input: unknown) {
    const remote = remoteWorkerSchema.safeParse(input);
    if (remote.success) {
      const message = remote.data;
      assert(
        this.sessions.get(session.workerId) === session &&
          message.workerId === session.workerId &&
          message.generation === session.generation,
        "worker_fenced",
        403,
      );
      const identity = await this.identity(session.workerId);
      assert(!identity.data.revoked && identity.data.generation === session.generation, "worker_fenced", 403);
      const receipt = await this.options.repo.getDocument<{ hash: string }>(
        this.options.scope,
        "worker-wire-receipt",
        message.messageId,
      );
      if (receipt) {
        assert(receipt.data.hash === sha256(message), "message_conflict");
        await this.remote.reconnect(session.workerId);
        this.send(session, { type: "ack", acknowledgedMessageId: message.messageId });
        return;
      }
      assert(message.sequence > session.sequence, "stale_sequence");
      await this.remote.receive(message);
      await this.options.repo.putDocument(
        this.options.scope,
        "worker-wire-receipt",
        message.messageId,
        { hash: sha256(message) },
        { immutable: true },
      );
      session.sequence = Math.max(session.sequence, message.sequence);
      const fresh = await this.identity(session.workerId);
      await this.options.repo.putDocument(
        this.options.scope,
        "worker",
        session.workerId,
        { ...fresh.data, sequence: session.sequence, lastSeenAt: new Date().toISOString() },
        { expectedRevision: fresh.revision },
      );
      this.send(session, { type: "ack", acknowledgedMessageId: message.messageId });
      return;
    }
    const message = workerMessageSchema.parse(input) as WorkerMessage;
    assert(this.sessions.get(session.workerId) === session, "worker_session_replaced");
    assert(message.workerId === session.workerId && message.generation === session.generation, "worker_fenced", 403);
    const identity = await this.identity(session.workerId);
    assert(!identity.data.revoked && identity.data.generation === session.generation, "worker_fenced", 403);
    const payload = message.payload;
    if (payload.type === "result" || payload.type === "started") {
      const lease = this.leases.get(payload.leaseId);
      assert(
        lease &&
          lease.workerId === session.workerId &&
          lease.generation === session.generation &&
          lease.actionId === payload.actionId,
        "lease_denied",
        403,
      );
      const priorReceipt = await this.options.repo.getDocument<{ hash: string }>(
        lease.scope,
        "worker_receipt",
        message.messageId,
      );
      if (priorReceipt) {
        assert(priorReceipt.data.hash === sha256(message), "message_conflict");
        this.send(session, { type: "ack", acknowledgedMessageId: message.messageId, actionId: payload.actionId });
        return;
      }
      assert(message.sequence > session.sequence, "stale_sequence");
      const currentLease = await this.options.repo.getDocument<WorkerLease>(lease.scope, "worker_lease", lease.id);
      assert(
        currentLease && currentLease.data.state === "active" && Date.parse(lease.expiresAt) > Date.now(),
        "lease_expired",
      );
      const action = await this.options.repo.getDocument<ToolAction>(lease.scope, "action", payload.actionId);
      assert(action, "action_not_found", 404);
      if (payload.type === "result") assert(payload.resultSha256 === wireHash(payload.data), "result_hash_mismatch");
      const nextAction =
        payload.type === "started"
          ? { ...action.data, status: "running" as const }
          : {
              ...action.data,
              status: payload.status,
              resultSha256: payload.resultSha256,
              evidenceRefs: payload.evidenceRefs,
            };
      const nextLease: WorkerLease = {
        ...currentLease.data,
        lastSequence: message.sequence,
        state: payload.type === "result" ? "completed" : "active",
      };
      await this.options.repo.transact(
        lease.scope,
        [
          { kind: "action", id: action.id, data: nextAction, expectedRevision: action.revision },
          { kind: "worker_lease", id: lease.id, data: nextLease, expectedRevision: currentLease.revision },
          {
            kind: "worker_receipt",
            id: message.messageId,
            data: {
              hash: sha256(message),
              actionId: payload.actionId,
              result: payload.type === "result" ? payload.data : null,
            },
            immutable: true,
          },
        ],
        { type: `worker.${payload.type}`, aggregateId: payload.actionId },
      );
      this.leases.set(lease.id, nextLease);
    } else {
      const priorReceipt = await this.options.repo.getDocument<{ hash: string }>(
        this.options.scope,
        "worker_receipt",
        message.messageId,
      );
      if (priorReceipt) {
        assert(priorReceipt.data.hash === sha256(message), "message_conflict");
        this.send(session, { type: "ack", acknowledgedMessageId: message.messageId });
        return;
      }
      assert(message.sequence > session.sequence, "stale_sequence");
      await this.options.repo.putDocument(
        this.options.scope,
        "worker_receipt",
        message.messageId,
        { hash: sha256(message) },
        { immutable: true },
      );
      if (payload.type === "hello")
        assert(
          payload.capabilities.every((c) => identity.data.capabilities.includes(c)) &&
            payload.maxConcurrent <= identity.data.maxConcurrent,
          "capability_denied",
        );
    }
    session.sequence = message.sequence;
    const fresh = await this.identity(session.workerId);
    await this.options.repo.putDocument(
      this.options.scope,
      "worker",
      session.workerId,
      { ...fresh.data, sequence: message.sequence, lastSeenAt: new Date().toISOString() },
      { expectedRevision: fresh.revision },
    );
    this.send(session, {
      type: "ack",
      acknowledgedMessageId: message.messageId,
      ...("actionId" in payload ? { actionId: payload.actionId } : {}),
    });
  }
  async dispatch(
    scope: Scope,
    actionId: string,
    workerId: string,
    authorization: Omit<AuthorizationInput, "action">,
    durationSeconds = 30,
  ): Promise<WorkerLease> {
    return this.lockDispatch(workerId, () =>
      this.dispatchNow(scope, actionId, workerId, authorization, durationSeconds),
    );
  }
  private async lockDispatch<T>(workerId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.dispatchQueues.get(workerId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    this.dispatchQueues.set(workerId, next);
    try {
      return await next;
    } finally {
      if (this.dispatchQueues.get(workerId) === next) this.dispatchQueues.delete(workerId);
    }
  }
  private async dispatchNow(
    scope: Scope,
    actionId: string,
    workerId: string,
    authorization: Omit<AuthorizationInput, "action">,
    durationSeconds = 30,
  ): Promise<WorkerLease> {
    assert(scope.companyId === this.options.scope.companyId, "scope_denied", 403);
    const identity = (await this.identity(workerId)).data,
      session = this.sessions.get(workerId);
    assert(
      session &&
        session.socket.readyState === WebSocket.OPEN &&
        !identity.revoked &&
        session.generation === identity.generation,
      "worker_unavailable",
    );
    const action = await this.options.repo.getDocument<ToolAction>(scope, "action", actionId);
    assert(action && ["proposed", "authorized"].includes(action.data.status), "action_not_dispatchable");
    assert(identity.capabilities.includes(action.data.toolId), "capability_denied", 403);
    assert(
      [...this.leases.values()].filter((l) => l.workerId === workerId && l.state === "active").length +
        (await this.remote.activeCount(workerId)) <
        identity.maxConcurrent,
      "worker_capacity",
    );
    await this.options.repo.assertAuthorized(scope, { ...authorization, action: action.data });
    assert(
      Number.isSafeInteger(durationSeconds) && durationSeconds > 0 && durationSeconds <= 3600,
      "invalid_lease_duration",
      400,
    );
    const lease: WorkerLease = {
      id: randomUUID(),
      workerId,
      generation: identity.generation,
      actionId,
      scope,
      expiresAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
      state: "active",
      lastSequence: 0,
    };
    const dispatched = { ...action.data, status: "dispatched" as const };
    await this.options.repo.authorizeAndTransact(
      scope,
      { ...authorization, action: action.data, durationSeconds },
      [
        { kind: "action", id: actionId, data: dispatched, expectedRevision: action.revision },
        { kind: "worker_lease", id: lease.id, data: lease, immutable: false },
      ],
      { type: "worker.dispatched", aggregateId: actionId },
    );
    this.leases.set(lease.id, lease);
    const currentIdentity = (await this.identity(workerId)).data;
    if (currentIdentity.revoked || currentIdentity.generation !== lease.generation) {
      await this.expire(lease);
      assert(false, "worker_fenced", 403);
    }
    this.send(session, {
      type: "dispatch",
      action: toolActionSchema.strip().parse(dispatched),
      leaseId: lease.id,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }
  async cancel(actionId: string, reason: string): Promise<void> {
    const remoteCancelled = await this.remote.cancel(actionId, reason);
    const lease = [...this.leases.values()].find((l) => l.actionId === actionId && l.state === "active");
    if (!lease && remoteCancelled) return;
    assert(lease, "lease_not_found", 404);
    const session = this.sessions.get(lease.workerId);
    if (session) this.send(session, { type: "cancel", actionId, reason });
    await this.expire(lease);
  }
  private async expireWorker(workerId: string) {
    for (const lease of this.leases.values())
      if (lease.workerId === workerId && lease.state === "active") await this.expire(lease);
  }
  private async expire(lease: WorkerLease) {
    const current = await this.options.repo.getDocument<WorkerLease>(lease.scope, "worker_lease", lease.id);
    if (!current || current.data.state !== "active") return;
    const action = await this.options.repo.getDocument<ToolAction>(lease.scope, "action", lease.actionId);
    assert(action, "action_not_found");
    const expired = { ...current.data, state: "expired" as const };
    await this.options.repo.transact(
      lease.scope,
      [
        { kind: "worker_lease", id: lease.id, data: expired, expectedRevision: current.revision },
        {
          kind: "action",
          id: action.id,
          data: { ...action.data, status: "effect_unknown" },
          expectedRevision: action.revision,
        },
      ],
      { type: "worker.effect_unknown", aggregateId: action.id },
    );
    this.leases.set(lease.id, expired);
  }
  async reconcileExpired(): Promise<void> {
    await this.remote.reconcileExpired();
    for (const lease of this.leases.values())
      if (lease.state === "active" && Date.parse(lease.expiresAt) <= Date.now()) await this.expire(lease);
  }
  async cancelAllRemote(reason = "control_shutdown") {
    await this.remote.cancelAll(reason);
  }
  remoteExecutionPort(workerId: string, directory: string) {
    return this.remote.port(workerId, directory);
  }
  handleTransfer(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    return this.remote.handleTransfer(req, res);
  }
  activeRemoteExecutions(): Promise<number> {
    return this.remote.activeCount();
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.options.server.off("upgrade", this.upgrade);
    for (const session of this.sessions.values()) session.socket.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
