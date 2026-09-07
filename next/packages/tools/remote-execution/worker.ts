import { hash } from "../isolation/files.ts";
import { mkdir, readFile, writeFile, rename, rm, open } from "node:fs/promises";
import path from "node:path";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { assert, sha256 } from "../../domain/src/index.ts";
import type { ExecutionPort, ExecutionResult } from "../isolation/types.ts";
import { ExecutionJournal } from "../journal.ts";
import { isVerifiedExecutionPort } from "../isolation/index.ts";
import { captureFiles, receiveFile, sendFile, verifyFile } from "./files.ts";
import {
  manifestHash,
  outputManifestHash,
  logsSchema,
  metadataSchema,
  assertControlSize,
  type RemoteControlMessage,
  type RemoteWorkerMessage,
  type Manifest,
  type RemoteResult,
} from "./protocol.ts";
type Dispatch = Extract<RemoteControlMessage["payload"], { type: "remote.dispatch" }>;
interface Receipt {
  dispatch: Dispatch;
  files: Manifest;
  logs?: Manifest;
  result: RemoteResult;
  uploadDirectory: string;
}
interface Options {
  directory: string;
  url: string;
  ca?: string | Buffer;
  port: ExecutionPort;
  send(payload: RemoteWorkerMessage["payload"]): Promise<void>;
  maxConcurrent: number;
}
export class RemoteExecutionWorker {
  private options: Options;
  private active = new Map<string, AbortController>();
  private journal: ExecutionJournal;
  constructor(options: Options) {
    assert(isVerifiedExecutionPort(options.port), "isolation_profile_unverified");
    this.options = options;
    this.journal = new ExecutionJournal(path.join(options.directory, "remote-journal"));
  }
  private root(id: string) {
    return path.join(this.options.directory, "remote-jobs", id);
  }
  private async store(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + "." + randomUUID() + ".tmp";
    const fd = await open(temp, "wx", 0o600);
    try {
      await fd.writeFile(JSON.stringify(value));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temp, file);
  }
  private url(id: string, direction: string, index: number) {
    const url = new URL(this.options.url);
    url.protocol = "https:";
    url.pathname = `/api/v1/worker-transfers/${id}/${direction}/${index}`;
    url.search = "";
    url.hash = "";
    return url;
  }
  private async transfer(
    method: "GET" | "PUT",
    dispatch: Dispatch,
    index: number,
    token: string,
    file: { size: number; sha256: string },
    local: string,
    signal: AbortSignal,
  ) {
    const url = this.url(dispatch.jobId, method === "GET" ? "input" : "output", index);
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method,
          ca: this.options.ca,
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            ...(method === "PUT" ? { "content-type": "application/octet-stream", "content-length": file.size } : {}),
          },
        },
        (res) => {
          if (method === "GET") {
            if (
              res.statusCode !== 200 ||
              Number(res.headers["content-length"]) !== file.size ||
              res.headers["x-content-sha256"] !== file.sha256
            ) {
              res.resume();
              reject(new Error("remote_input_rejected"));
              return;
            }
            void receiveFile(res, local, file).then(resolve, reject);
          } else {
            res.resume();
            res.once("end", () => (res.statusCode === 204 ? resolve() : reject(new Error("remote_upload_rejected"))));
          }
        },
      );
      req.setTimeout(15000, () => req.destroy(new Error("remote_transfer_timeout")));
      req.once("error", reject);
      if (method === "PUT") void pipeline(sendFile(local), req).catch(reject);
      else req.end();
    });
  }
  private async permit(dispatch: Dispatch, signal: AbortSignal) {
    const url = this.url(dispatch.jobId, "input", 0);
    url.pathname = `/api/v1/worker-transfers/${dispatch.jobId}/start`;
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          ca: this.options.ca,
          signal,
          headers: { authorization: `Bearer ${dispatch.inputToken}`, "content-length": 0 },
        },
        (res) => {
          res.resume();
          res.once("end", () => (res.statusCode === 204 ? resolve() : reject(new Error("execution_permit_denied"))));
        },
      );
      req.setTimeout(15000, () => req.destroy(new Error("execution_permit_timeout")));
      req.once("error", reject);
      req.end();
    });
  }
  async receive(payload: RemoteControlMessage["payload"]) {
    if (payload.type === "remote.cancel") {
      this.active.get(payload.jobId)?.abort(new Error(payload.reason));
      this.uploadControllers.get(payload.jobId)?.abort(new Error(payload.reason));
      return;
    }
    if (payload.type === "remote.upload") {
      void this.upload(payload).catch(() => {});
      return;
    }
    assert(Date.parse(payload.expiresAt) > Date.now(), "lease_expired");
    assert(
      payload.jobId === payload.action.id &&
        sha256(payload.scope) === sha256(payload.action.scope) &&
        payload.action.toolId === "workspace.execute",
      "remote_scope_mismatch",
    );
    assert(
      payload.action.argumentsSha256 === sha256(payload.action.args) &&
        typeof payload.action.args === "object" &&
        payload.action.args !== null &&
        !Array.isArray(payload.action.args) &&
        payload.action.args.inputManifestSha256 === manifestHash(payload.files),
      "remote_input_manifest_mismatch",
    );
    if (this.active.has(payload.jobId)) return;
    assert(this.active.size < this.options.maxConcurrent, "worker_capacity");
    const controller = new AbortController();
    this.active.set(payload.jobId, controller);
    void this.execute(payload, controller)
      .catch(() => {})
      .finally(() => this.active.delete(payload.jobId));
  }
  private async execute(dispatch: Dispatch, controller: AbortController) {
    const root = this.root(dispatch.jobId),
      expires = Math.max(1, Date.parse(dispatch.expiresAt) - Date.now());
    const timer = setTimeout(() => controller.abort(), expires);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const receiptFile = path.join(root, "receipt.json");
      try {
        const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as Receipt;
        assert(sha256(receipt.dispatch.action) === sha256(dispatch.action), "remote_action_changed");
        await this.options.send({
          type: "remote.output",
          jobId: dispatch.jobId,
          files: receipt.files,
          logs: receipt.logs,
          result: receipt.result,
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const recovered = await this.journal.recover(dispatch.jobId, dispatch.action.argumentsSha256);
      const workspace = path.join(root, "workspace");
      if (!recovered) {
        await rm(workspace, { recursive: true, force: true });
        await mkdir(workspace, { mode: 0o700 });
        for (const [index, file] of dispatch.files.entries())
          await this.transfer(
            "GET",
            dispatch,
            index,
            dispatch.inputToken,
            file,
            path.join(workspace, file.path),
            controller.signal,
          );
        await this.permit(dispatch, controller.signal);
      }
      const result =
        recovered ??
        (await this.journal.execute(dispatch.jobId, dispatch.action.argumentsSha256, () =>
          this.options.port.execute({ ...dispatch.request, workspaceRoot: workspace, signal: controller.signal }),
        ));
      if (result.status !== "succeeded") {
        await this.options.send({
          type: "remote.failed",
          jobId: dispatch.jobId,
          code: "remote_execution_" + result.status,
          unknown: result.status === "effect_unknown",
        });
        return;
      }
      const execution = result.data as ExecutionResult;
      const uploadDirectory = path.join(root, "upload");
      await rm(uploadDirectory, { recursive: true, force: true });
      const files = await captureFiles(execution.outputDirectory, uploadDirectory);
      const { outputDirectory: _outside, ...raw } = execution;
      void _outside;
      const logs = logsSchema.parse([
        { path: "stdout", size: Buffer.byteLength(execution.stdout), sha256: hash(execution.stdout) },
        { path: "stderr", size: Buffer.byteLength(execution.stderr), sha256: hash(execution.stderr) },
      ]);
      await writeFile(path.join(uploadDirectory, String(files.length)), execution.stdout, { mode: 0o600 });
      await writeFile(path.join(uploadDirectory, String(files.length + 1)), execution.stderr, { mode: 0o600 });
      for (const index of [files.length, files.length + 1]) {
        // FlushFileBuffers on Windows requires write access without truncating the captured log.
        const fd = await open(path.join(uploadDirectory, String(index)), "r+");
        try {
          await fd.sync();
        } finally {
          await fd.close();
        }
      }
      const metadata = metadataSchema.parse({ ...raw, stdout: "", stderr: "" });
      assert(
        sha256(metadata.outputHashes) === sha256(Object.fromEntries(files.map((f) => [f.path, f.sha256]))),
        "output_manifest_mismatch",
      );
      const receipt: Receipt = { dispatch, files, logs, result: metadata, uploadDirectory };
      assertControlSize({ type: "remote.output", jobId: dispatch.jobId, files, logs, result: metadata });
      await this.store(receiptFile, receipt);
      await this.options.send({ type: "remote.output", jobId: dispatch.jobId, files, logs, result: metadata });
    } catch (error) {
      await this.options.send({
        type: "remote.failed",
        jobId: dispatch.jobId,
        code: error instanceof Error ? error.message.slice(0, 200) : "remote_execution_failed",
        unknown: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  private uploading = new Set<string>();
  private uploadControllers = new Map<string, AbortController>();
  private async upload(ticket: Extract<RemoteControlMessage["payload"], { type: "remote.upload" }>) {
    if (this.uploading.has(ticket.jobId)) return;
    this.uploading.add(ticket.jobId);
    const controller = new AbortController();
    this.uploadControllers.set(ticket.jobId, controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, Date.parse(ticket.expiresAt) - Date.now()));
    try {
      const receipt = JSON.parse(await readFile(path.join(this.root(ticket.jobId), "receipt.json"), "utf8")) as Receipt;
      assert(ticket.manifestSha256 === outputManifestHash(receipt.files, receipt.logs), "output_manifest_changed");
      for (const [index, file] of [...receipt.files, ...(receipt.logs ?? [])].entries()) {
        const source = path.join(receipt.uploadDirectory, String(index));
        await verifyFile(source, file);
        for (;;) {
          try {
            await this.transfer("PUT", receipt.dispatch, index, ticket.token, file, source, controller.signal);
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      await this.options.send({ type: "remote.complete", jobId: ticket.jobId, manifestSha256: ticket.manifestSha256 });
    } finally {
      clearTimeout(timer);
      this.uploading.delete(ticket.jobId);
      this.uploadControllers.delete(ticket.jobId);
    }
  }
  stop() {
    for (const controller of this.active.values()) controller.abort();
    for (const controller of this.uploadControllers.values()) controller.abort();
  }
}
