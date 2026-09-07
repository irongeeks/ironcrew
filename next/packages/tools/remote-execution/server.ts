import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, copyFile, open } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Repository, type Document } from "../../persistence/src/index.ts";
import { assert, sha256 } from "../../domain/src/index.ts";
import type { Scope, ToolAction, Json } from "../../contracts/src/index.ts";
import type { ExecutionRequest, ExecutionResult, Attestation } from "../isolation/types.ts";
import { hash, canonical } from "../isolation/files.ts";
import { captureFiles, receiveFile, sendFile, verifyFile } from "./files.ts";
import {
  MAX_BYTES,
  requestSchema,
  metadataSchema,
  manifestHash,
  outputManifestHash,
  logsSchema,
  manifestSchema,
  stableId,
  assertControlSize,
  type Manifest,
  type RemoteControlMessage,
  type RemoteWorkerMessage,
  type RemoteResult,
} from "./protocol.ts";
import { createRemotePort } from "./port.ts";
interface Identity {
  id: string;
  generation: number;
  revoked: boolean;
  capabilities: string[];
  maxConcurrent: number;
}
export interface RemoteHooks {
  identity(id: string): Promise<Identity>;
  online(id: string): boolean;
  lock<T>(id: string, operation: () => Promise<T>): Promise<T>;
  legacyActive(id: string): number;
  send(id: string, payload: RemoteControlMessage["payload"]): void;
}
interface RemoteJob {
  id: string;
  scope: Scope;
  orderId: string;
  workerId: string;
  generation: number;
  child: ToolAction;
  input: Manifest;
  request: ReturnType<typeof requestSchema.parse>;
  expiresAt: string;
  attestation: Attestation;
  state: "dispatched" | "uploading" | "completed" | "failed" | "effect_unknown";
  authority: NonNullable<ExecutionRequest["context"]>["authority"];
  permitIssuedAt?: string;
  output?: Manifest;
  logs?: Manifest;
  metadata?: RemoteResult;
  result?: ExecutionResult;
  code?: string;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;
const probeNames = [
  "trusted_program_runs",
  "node_version",
  "seccomp_syscall",
  "kernel_namespaces",
  "capabilities_seccomp",
  "environment",
  "filesystem",
  "network",
  "host_process",
  "process_limit",
  "memory_limit",
  "cpu_timeout",
  "output_limit",
  "workspace_quota",
  "symlink_export",
  "nested_namespace",
];
export class RemoteExecutionServer {
  #coordinator = true;
  static isCoordinator(value: object) {
    return #coordinator in value;
  }
  readonly repo: Repository;
  readonly companyScope: Scope;
  readonly directory?: string;
  private hooks: RemoteHooks;
  private serial = new Map<string, Promise<unknown>>();
  private jobs = new Map<string, Scope>();
  private initialized?: Promise<void>;
  private secret?: Buffer;
  private closing = false;
  constructor(repo: Repository, scope: Scope, hooks: RemoteHooks, directory?: string) {
    this.repo = repo;
    this.companyScope = scope;
    this.hooks = hooks;
    this.directory = directory ? path.join(path.resolve(directory), "worker-transfers") : undefined;
  }
  private async init() {
    if (!this.initialized)
      this.initialized = (async () => {
        for (const doc of await this.repo.listCompanyDocuments<RemoteJob>(
          this.companyScope.companyId,
          "remote-execution",
        ))
          this.jobs.set(doc.id, doc.scope);
        if (!this.directory) return;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, "ticket-key");
        try {
          this.secret = await readFile(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.secret = randomBytes(32);
          const fd = await open(file, "wx", 0o600);
          try {
            await fd.writeFile(this.secret);
            await fd.sync();
          } finally {
            await fd.close();
          }
        }
        assert(this.secret.length === 32, "remote_ticket_key_corrupt");
      })();
    await this.initialized;
  }
  port(workerId: string, directory: string) {
    assert(this.directory === path.join(path.resolve(directory), "worker-transfers"), "remote_storage_not_configured");
    return createRemotePort(this, workerId);
  }
  private root(id: string) {
    assert(this.directory, "remote_storage_not_configured");
    return path.join(this.directory, id);
  }
  private token(job: RemoteJob, direction: "input" | "output") {
    assert(this.secret, "remote_storage_not_configured");
    return createHmac("sha256", this.secret)
      .update(
        canonical({
          id: job.id,
          scope: job.scope,
          workerId: job.workerId,
          generation: job.generation,
          direction,
          expiresAt: job.expiresAt,
          manifest: direction === "input" ? manifestHash(job.input) : outputManifestHash(job.output ?? [], job.logs),
        }),
      )
      .digest("base64url");
  }
  private async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const old = this.serial.get(key) ?? Promise.resolve();
    const next = old.catch(() => {}).then(operation);
    this.serial.set(key, next);
    try {
      return await next;
    } finally {
      if (this.serial.get(key) === next) this.serial.delete(key);
    }
  }
  private async job(id: string) {
    await this.init();
    const scope = this.jobs.get(id);
    assert(scope, "remote_job_not_found", 404);
    const job = await this.repo.getDocument<RemoteJob>(scope, "remote-execution", id);
    assert(job, "remote_job_not_found", 404);
    return job;
  }
  private async live(job: RemoteJob) {
    const worker = await this.hooks.identity(job.workerId);
    assert(!worker.revoked && worker.generation === job.generation, "worker_fenced", 403);
    assert(Date.parse(job.expiresAt) > Date.now(), "remote_ticket_expired", 403);
    assert(!["completed", "failed", "effect_unknown"].includes(job.state), "remote_job_closed", 409);
  }
  private async authorize(job: RemoteJob) {
    await this.repo.assertDispatchAllowed(job.scope.companyId);
    if (job.authority.kind === "tool") {
      const parent = await this.repo.getDocument<ToolAction>(job.scope, "action", job.authority.actionId);
      assert(
        parent &&
          parent.data.orderId === job.orderId &&
          ["proposed", "authorized", "running", "dispatched"].includes(parent.data.status),
        "parent_action_not_active",
      );
    }
    await this.repo.assertAuthorized(job.scope, {
      action: job.child,
      targetId: job.authority.kind === "tool" ? job.authority.targetId : job.orderId,
      effect: "workspace_write",
      durationSeconds: Math.ceil(job.request.timeoutMs / 1000),
    });
  }
  async execute(workerId: string, request: ExecutionRequest): Promise<ExecutionResult> {
    assert(!this.closing, "remote_dispatch_stopped");
    request.signal?.throwIfAborted();
    await this.init();
    assert(this.directory, "remote_storage_not_configured");
    const context = request.context;
    assert(context, "execution_context_required");
    assert(context.scope.companyId === this.companyScope.companyId, "scope_denied", 403);
    const order = await this.repo.getOrder(context.scope, context.orderId);
    assert(order, "order_not_found", 404);
    const spec = requestSchema.parse({
      argv: request.argv,
      timeoutMs: request.timeoutMs ?? 30000,
      maxOutputBytes: request.maxOutputBytes ?? MAX_BYTES,
      outputPaths: request.outputPaths ?? ["."],
    });
    const snapshot = await mkdtemp(path.join(this.directory, "capture-"));
    let input: Manifest;
    try {
      input = await captureFiles(request.workspaceRoot, snapshot);
    } catch (error) {
      await rm(snapshot, { recursive: true, force: true });
      throw error;
    }
    const jobId = stableId({
      scope: context.scope,
      orderId: context.orderId,
      authority: context.authority,
      request: spec,
      manifest: manifestHash(input),
    });
    try {
      await this.hooks.lock(workerId, async () => {
        assert(!this.closing, "remote_dispatch_stopped");
        request.signal?.throwIfAborted();
        const prior = await this.repo.getDocument<RemoteJob>(context.scope, "remote-execution", jobId);
        if (prior) {
          this.jobs.set(jobId, context.scope);
          return;
        }
        const worker = await this.hooks.identity(workerId);
        assert(
          !worker.revoked && worker.capabilities.includes("workspace.execute") && this.hooks.online(workerId),
          "worker_unavailable",
        );
        const evidence = await this.repo.getDocument<{ generation: number; attestation: Attestation }>(
          this.companyScope,
          "worker-attestation",
          workerId,
        );
        assert(
          evidence &&
            evidence.data.generation === worker.generation &&
            Date.parse(evidence.data.attestation.expiresAt) > Date.now() + spec.timeoutMs,
          "worker_isolation_unverified",
        );
        assert(
          probeNames.every((name) => evidence.data.attestation.probes[name]?.passed),
          "worker_isolation_unverified",
        );
        const active = (
          await this.repo.listCompanyDocuments<RemoteJob>(context.scope.companyId, "remote-execution")
        ).filter(
          (d) =>
            d.data.workerId === workerId &&
            ["dispatched", "uploading"].includes(d.data.state) &&
            Date.parse(d.data.expiresAt) > Date.now(),
        );
        assert(active.length + this.hooks.legacyActive(workerId) < worker.maxConcurrent, "worker_capacity");
        let mandateId: string, mandateVersion: number, runId: string;
        if (context.authority.kind === "tool") {
          const parent = await this.repo.getDocument<ToolAction>(context.scope, "action", context.authority.actionId);
          assert(
            parent &&
              parent.data.orderId === context.orderId &&
              ["proposed", "authorized", "running", "dispatched"].includes(parent.data.status),
            "parent_action_not_active",
          );
          assert(parent.data.mandateId && parent.data.mandateVersion, "mandate_required");
          mandateId = parent.data.mandateId;
          mandateVersion = parent.data.mandateVersion;
          runId = parent.data.runId;
        } else {
          const ceo = await this.repo.getIdentity();
          assert(
            ceo?.id === context.authority.ceoId && ceo.companyId === context.scope.companyId,
            "ceo_authority_denied",
            403,
          );
          mandateId = stableId({ jobId, kind: "ceo-execution-mandate" });
          mandateVersion = 1;
          runId = context.authority.requestId;
        }
        const args = json({ ...spec, inputManifestSha256: manifestHash(input), parentAuthority: context.authority });
        const child: ToolAction = {
          id: jobId,
          runId,
          orderId: context.orderId,
          scope: context.scope,
          toolId: "workspace.execute",
          toolVersion: 1,
          args,
          argumentsSha256: sha256(args),
          status: "dispatched",
          mandateId,
          mandateVersion,
          evidenceRefs: [],
        };
        const expiresAt = new Date(Date.now() + Math.min(360000, spec.timeoutMs + 60000)).toISOString();
        if (
          context.authority.kind === "ceo" &&
          !(await this.repo.getDocument(context.scope, "mandate", `${mandateId}:1`))
        )
          await this.repo.createMandate({
            id: mandateId,
            version: 1,
            scope: context.scope,
            allowedToolIds: ["workspace.execute"],
            targetIds: [context.orderId],
            parameterConstraints: args,
            expiresAt,
            maxAttempts: 1,
            maxDurationSeconds: Math.ceil(spec.timeoutMs / 1000),
            maxCostUsdMicros: "0",
          });
        const job: RemoteJob = {
          id: jobId,
          scope: context.scope,
          orderId: context.orderId,
          workerId,
          generation: worker.generation,
          child,
          input,
          request: spec,
          expiresAt,
          attestation: evidence.data.attestation,
          state: "dispatched",
          authority: context.authority,
        };
        await mkdir(this.root(jobId), { recursive: true, mode: 0o700 });
        await rename(snapshot, path.join(this.root(jobId), "input"));
        await this.repo.authorizeAndTransact(
          context.scope,
          {
            action: child,
            targetId: context.authority.kind === "tool" ? context.authority.targetId : context.orderId,
            effect: "workspace_write",
            durationSeconds: Math.ceil(spec.timeoutMs / 1000),
          },
          [
            { kind: "action", id: jobId, data: json(child), immutable: false },
            { kind: "remote-execution", id: jobId, data: json(job), immutable: false },
          ],
          { type: "worker.remote_dispatched", aggregateId: jobId },
        );
        this.jobs.set(jobId, context.scope);
        if (this.closing || request.signal?.aborted)
          await this.fail(await this.job(jobId), this.closing ? "control_shutdown" : "execution_cancelled", true);
        else this.dispatch(job);
      });
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
    let nextAuthorizationCheck = 0;
    for (;;) {
      const stored = await this.job(jobId),
        job = stored.data;
      assert(job.workerId === workerId, "remote_worker_changed");
      if (job.state === "completed") {
        assert(job.result, "remote_result_missing");
        for (const [i, file] of (job.output ?? []).entries())
          await verifyFile(path.join(this.root(jobId), "output", String(i)), file);
        const outputDirectory = path.join(this.root(jobId), "artifacts");
        for (const file of job.output ?? []) await verifyFile(path.join(outputDirectory, file.path), file);
        return { ...job.result, outputDirectory };
      }
      if (request.signal?.aborted) {
        await this.cancel(jobId, "execution_cancelled");
        throw new Error("execution_cancelled");
      }
      if (job.state === "failed" || job.state === "effect_unknown")
        throw new Error(job.code ?? "remote_execution_unknown");
      if (Date.parse(job.expiresAt) <= Date.now()) {
        await this.locked(jobId, async () => this.fail(await this.job(jobId), "remote_lease_expired", true));
        throw new Error("remote_lease_expired");
      }
      if (Date.now() >= nextAuthorizationCheck) {
        nextAuthorizationCheck = Date.now() + 250;
        try {
          await this.authorize(job);
        } catch {
          await this.locked(jobId, async () => this.fail(await this.job(jobId), "execution_authority_revoked", true));
          throw new Error("execution_authority_revoked");
        }
      }
      const worker = await this.hooks.identity(workerId);
      if (worker.revoked || worker.generation !== job.generation) {
        await this.locked(jobId, async () => this.fail(await this.job(jobId), "worker_fenced", true));
        throw new Error("worker_fenced");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  private dispatch(job: RemoteJob) {
    const payload: RemoteControlMessage["payload"] = {
      type: "remote.dispatch",
      jobId: job.id,
      scope: job.scope,
      action: job.child,
      request: job.request,
      files: job.input,
      inputToken: this.token(job, "input"),
      expiresAt: job.expiresAt,
    };
    assertControlSize(payload);
    this.hooks.send(job.workerId, payload);
  }
  async reconnect(workerId: string) {
    await this.init();
    for (const [id] of this.jobs) {
      const job = (await this.job(id)).data;
      if (job.workerId === workerId && Date.parse(job.expiresAt) > Date.now()) {
        if (job.state === "dispatched") this.dispatch(job);
        else if (job.state === "uploading") this.upload(job);
      }
    }
  }
  private async fail(stored: Document<RemoteJob>, code: string, unknown: boolean) {
    const job = stored.data;
    if (["completed", "failed", "effect_unknown"].includes(job.state)) return;
    this.hooks.send(job.workerId, { type: "remote.cancel", jobId: job.id, reason: code.slice(0, 200) });
    const action = await this.repo.getDocument<ToolAction>(job.scope, "action", job.id);
    await this.repo.transact(
      job.scope,
      [
        {
          kind: "remote-execution",
          id: job.id,
          data: json({ ...job, state: unknown ? "effect_unknown" : "failed", code }),
          expectedRevision: stored.revision,
        },
        ...(action
          ? [
              {
                kind: "action",
                id: job.id,
                data: json({ ...action.data, status: unknown ? "effect_unknown" : "failed" }),
                expectedRevision: action.revision,
              },
            ]
          : []),
      ],
      { type: "worker.remote_failed", aggregateId: job.id },
    );
  }
  async receive(message: RemoteWorkerMessage) {
    await this.init();
    const payload = message.payload;
    if (payload.type === "remote.hello") {
      assert(
        probeNames.every((name) => payload.attestation.probes[name]?.passed) &&
          Date.parse(payload.attestation.expiresAt) > Date.now(),
        "worker_isolation_unverified",
      );
      const prior = await this.repo.getDocument(this.companyScope, "worker-attestation", message.workerId);
      await this.repo.putDocument(
        this.companyScope,
        "worker-attestation",
        message.workerId,
        json({ generation: message.generation, attestation: payload.attestation }),
        prior ? { expectedRevision: prior.revision } : {},
      );
      await this.reconnect(message.workerId);
      return;
    }
    await this.locked(payload.jobId, async () => {
      const stored = await this.job(payload.jobId),
        job = stored.data;
      assert(job.workerId === message.workerId && job.generation === message.generation, "worker_fenced", 403);
      const receipt = await this.repo.getDocument<{ hash: string }>(job.scope, "remote-receipt", message.messageId);
      if (receipt) {
        assert(receipt.data.hash === sha256(message), "message_conflict");
        if (payload.type === "remote.output" && job.state === "uploading") this.upload(job);
        return;
      }
      if (["completed", "failed", "effect_unknown"].includes(job.state)) {
        await this.repo.putDocument(
          job.scope,
          "remote-receipt",
          message.messageId,
          { hash: sha256(message), late: true },
          { immutable: true },
        );
        return;
      }
      await this.live(job);
      if (payload.type === "remote.failed") {
        await this.fail(stored, payload.code, payload.unknown);
        return;
      }
      if (payload.type === "remote.output") {
        assert(job.permitIssuedAt, "execution_permit_required", 403);
        const files = manifestSchema.parse(payload.files),
          logs = payload.logs ? logsSchema.parse(payload.logs) : undefined,
          metadata = metadataSchema.parse(payload.result);
        assert(
          metadata.attestationId === job.attestation.id &&
            metadata.profileSha256 === job.attestation.profileSha256 &&
            metadata.toolchainSha256 === job.attestation.toolchainSha256,
          "attestation_changed",
        );
        assert(!logs || (!metadata.stdout && !metadata.stderr), "inline_log_conflict");
        assert(files.reduce((n, f) => n + f.size, 0) <= job.request.maxOutputBytes, "output_size_limit");
        assert(
          canonical(Object.fromEntries(files.map((f) => [f.path, f.sha256]))) === canonical(metadata.outputHashes),
          "output_manifest_mismatch",
        );
        assert(
          files.every((f) =>
            job.request.outputPaths.some((p) => p === "." || f.path === p || f.path.startsWith(p + "/")),
          ),
          "output_path_denied",
        );
        if (job.output)
          assert(
            outputManifestHash(job.output, job.logs) === outputManifestHash(files, logs) &&
              sha256(job.metadata) === sha256(metadata),
            "output_manifest_changed",
          );
        const next = { ...job, state: "uploading" as const, output: files, logs, metadata };
        await this.repo.transact(
          job.scope,
          [
            { kind: "remote-execution", id: job.id, data: json(next), expectedRevision: stored.revision },
            { kind: "remote-receipt", id: message.messageId, data: { hash: sha256(message) }, immutable: true },
          ],
          { type: "worker.remote_output_manifest", aggregateId: job.id },
        );
        this.upload(next);
      } else {
        assert(
          job.state === "uploading" &&
            job.output &&
            job.metadata &&
            payload.manifestSha256 === outputManifestHash(job.output, job.logs),
          "output_manifest_mismatch",
        );
        for (const [i, file] of [...job.output, ...(job.logs ?? [])].entries())
          await verifyFile(path.join(this.root(job.id), "output", String(i)), file);
        const outputDirectory = path.join(this.root(job.id), "artifacts");
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        for (const [i, file] of job.output.entries()) {
          const dest = path.join(outputDirectory, file.path);
          await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await copyFile(path.join(this.root(job.id), "output", String(i)), dest);
          await verifyFile(dest, file);
          const handle = await open(dest, "r");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        const result: ExecutionResult = {
          ...job.metadata,
          ...(job.logs
            ? {
                stdout: await readFile(path.join(this.root(job.id), "output", String(job.output.length)), "utf8"),
                stderr: await readFile(path.join(this.root(job.id), "output", String(job.output.length + 1)), "utf8"),
              }
            : {}),
          outputDirectory,
        };
        const action = await this.repo.getDocument<ToolAction>(job.scope, "action", job.id);
        assert(action, "action_not_found");
        await this.repo.transact(
          job.scope,
          [
            {
              kind: "remote-execution",
              id: job.id,
              data: json({ ...job, state: "completed", result }),
              expectedRevision: stored.revision,
            },
            {
              kind: "action",
              id: job.id,
              data: json({
                ...action.data,
                status: result.exitCode === 0 && result.termination === "exited" ? "succeeded" : "failed",
                resultSha256: hash(JSON.stringify(result)),
              }),
              expectedRevision: action.revision,
            },
            { kind: "remote-receipt", id: message.messageId, data: { hash: sha256(message) }, immutable: true },
          ],
          { type: "worker.remote_completed", aggregateId: job.id },
        );
      }
    });
  }
  async cancel(actionId: string, reason: string) {
    await this.init();
    let count = 0;
    for (const [id] of this.jobs) {
      const stored = await this.job(id),
        job = stored.data;
      if (
        (job.id === actionId || (job.authority.kind === "tool" && job.authority.actionId === actionId)) &&
        ["dispatched", "uploading"].includes(job.state)
      ) {
        await this.locked(job.id, async () => this.fail(await this.job(job.id), reason, true));
        count++;
      }
    }
    return count;
  }
  async cancelWorker(workerId: string) {
    await this.init();
    for (const [id] of this.jobs) {
      const stored = await this.job(id);
      if (stored.data.workerId === workerId)
        await this.locked(id, async () => this.fail(await this.job(id), "worker_fenced", true));
    }
  }
  async reconcileExpired() {
    await this.init();
    for (const [id] of this.jobs)
      await this.locked(id, async () => {
        const stored = await this.job(id);
        if (["dispatched", "uploading"].includes(stored.data.state) && Date.parse(stored.data.expiresAt) <= Date.now())
          await this.fail(stored, "remote_lease_expired", true);
      });
  }
  async cancelAll(reason: string) {
    this.closing = true;
    await this.init();
    for (const [id] of this.jobs) await this.cancel(id, reason);
  }
  private checkToken(value: string | undefined, expected: string) {
    assert(/^Bearer [A-Za-z0-9_-]{43}$/.test(value ?? ""), "transfer_unauthorized", 403);
    assert(timingSafeEqual(Buffer.from(value!.slice(7)), Buffer.from(expected)), "transfer_unauthorized", 403);
  }
  private upload(job: RemoteJob) {
    this.hooks.send(job.workerId, {
      type: "remote.upload",
      jobId: job.id,
      manifestSha256: outputManifestHash(job.output ?? [], job.logs),
      token: this.token(job, "output"),
      expiresAt: job.expiresAt,
    });
  }
  async activeCount(workerId?: string) {
    await this.init();
    return (await this.repo.listCompanyDocuments<RemoteJob>(this.companyScope.companyId, "remote-execution")).filter(
      (d) =>
        (!workerId || d.data.workerId === workerId) &&
        ["dispatched", "uploading"].includes(d.data.state) &&
        Date.parse(d.data.expiresAt) > Date.now(),
    ).length;
  }
  async handleTransfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      assert((req.socket as import("node:tls").TLSSocket).encrypted, "tls_required", 403);
      const url = new URL(
        (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/",
        "https://worker.invalid",
      );
      const permit = /^\/api\/v1\/worker-transfers\/([a-f0-9-]{36})\/start$/.exec(url.pathname);
      if (permit) {
        assert(
          req.method === "POST" && !url.search && Number(req.headers["content-length"]) === 0,
          "invalid_execution_permit",
          400,
        );
        await this.locked(permit[1]!, async () => {
          const stored = await this.job(permit[1]!),
            job = stored.data;
          await this.live(job);
          this.checkToken(req.headers.authorization, this.token(job, "input"));
          await this.authorize(job);
          const action = await this.repo.getDocument<ToolAction>(job.scope, "action", job.id);
          assert(action, "action_not_found");
          await this.repo.authorizeAndTransact(
            job.scope,
            {
              action: job.child,
              targetId: job.authority.kind === "tool" ? job.authority.targetId : job.orderId,
              effect: "workspace_write",
              durationSeconds: Math.ceil(job.request.timeoutMs / 1000),
            },
            [
              {
                kind: "remote-execution",
                id: job.id,
                data: json({ ...job, permitIssuedAt: job.permitIssuedAt ?? new Date().toISOString() }),
                expectedRevision: stored.revision,
              },
              {
                kind: "action",
                id: job.id,
                data: json({ ...action.data, status: "running" }),
                expectedRevision: action.revision,
              },
            ],
            { type: "worker.remote_execution_permit", aggregateId: job.id },
          );
        });
        res.writeHead(204);
        res.end();
        return;
      }
      const match = /^\/api\/v1\/worker-transfers\/([a-f0-9-]{36})\/(input|output)\/(0|[1-9][0-9]{0,3})$/.exec(
        url.pathname,
      );
      assert(match && !url.search, "invalid_transfer_path", 400);
      const [, id, direction, indexText] = match,
        index = Number(indexText);
      const stored = await this.job(id!),
        job = stored.data;
      await this.live(job);
      const authorization = req.headers.authorization ?? "";
      assert(/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization), "transfer_unauthorized", 403);
      const token = authorization.slice(7);
      const expected = this.token(job, direction as "input" | "output");
      assert(
        token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected)),
        "transfer_unauthorized",
        403,
      );
      const file = (direction === "input" ? job.input : [...(job.output ?? []), ...(job.logs ?? [])])?.[index];
      assert(file, "transfer_file_not_found", 404);
      if (direction === "input") {
        assert(req.method === "GET", "method_denied", 400);
        await this.authorize(job);
        const source = path.join(this.root(job.id), "input", String(index));
        await verifyFile(source, file);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": file.size,
          "x-content-sha256": file.sha256,
          "cache-control": "no-store",
        });
        const timer = setTimeout(() => res.destroy(new Error("download_timeout")), 15000);
        try {
          await pipeline(sendFile(source), res);
        } finally {
          clearTimeout(timer);
        }
      } else {
        assert(req.method === "PUT" && job.state === "uploading", "method_denied", 400);
        assert(req.headers["content-type"] === "application/octet-stream", "content_type_denied", 400);
        assert(Number(req.headers["content-length"]) === file.size, "upload_size_limit", 413);
        await this.locked(`${job.id}:file:${index}`, async () => {
          const timer = setTimeout(() => req.destroy(new Error("upload_timeout")), 15000);
          try {
            await receiveFile(req, path.join(this.root(job.id), "output", String(index)), file);
            await this.live((await this.job(job.id)).data);
          } finally {
            clearTimeout(timer);
          }
        });
        res.writeHead(204);
        res.end();
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "transfer_failed",
        status =
          typeof (error as { status?: number }).status === "number"
            ? (error as { status: number }).status
            : /size_limit/.test(code)
              ? 413
              : /hash|changed|closed|mismatch/.test(code)
                ? 409
                : 500;
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: { code } }));
      } else res.destroy();
    }
  }
}
