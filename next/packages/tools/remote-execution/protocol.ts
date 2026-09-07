import { z } from "zod";
import { scopeSchema, toolActionSchema } from "../../contracts/src/index.ts";
import { safeRelative, hash, canonical } from "../isolation/files.ts";
export const MAX_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 1024;
export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_CONTROL = 1024 * 1024;
export const fileSchema = z
  .object({
    path: z.string().max(512).refine(safeRelative),
    size: z.number().int().min(0).max(MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const manifestSchema = z
  .array(fileSchema)
  .max(MAX_FILES)
  .superRefine((files, ctx) => {
    if (
      files.reduce((n, f) => n + f.size, 0) > MAX_BYTES ||
      new Set(files.map((f) => f.path.normalize("NFC").toLowerCase())).size !== files.length ||
      Buffer.byteLength(JSON.stringify(files)) > 300000
    )
      ctx.addIssue({ code: "custom", message: "Manifest limit or duplicate" });
    const names = new Set(files.map((f) => f.path.normalize("NFC").toLowerCase()));
    for (const f of files) {
      let parent = f.path.normalize("NFC").toLowerCase();
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        if (names.has(parent)) ctx.addIssue({ code: "custom", message: "File/directory collision" });
      }
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;
export const logsSchema = manifestSchema.refine(
  (files) =>
    files.length === 2 &&
    files[0]?.path === "stdout" &&
    files[1]?.path === "stderr" &&
    files.reduce((n, f) => n + f.size, 0) <= MAX_LOG_BYTES,
  "Log transfer limit",
);
export const outputManifestHash = (files: Manifest, logs?: Manifest) =>
  logs ? hash(canonical({ files: manifestSchema.parse(files), logs: logsSchema.parse(logs) })) : manifestHash(files);
export const manifestHash = (files: Manifest) => hash(canonical(manifestSchema.parse(files)));
export const requestSchema = z
  .object({
    argv: z.array(z.string().max(65536)).min(1).max(128),
    timeoutMs: z.number().int().positive().max(300000),
    maxOutputBytes: z.number().int().positive().max(MAX_BYTES),
    outputPaths: z.array(z.string().refine((p) => p === "." || safeRelative(p))).max(64),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 128000, "Execution control limit");
export const metadataSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    stdout: z.string().max(4096),
    stderr: z.string().max(4096),
    termination: z.enum(["exited", "timeout", "output_limit", "resource_limit", "invalid_output", "cancelled"]),
    attestationId: z.uuid(),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolchainSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outputHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    resources: z.object({
      memoryEvents: z.record(z.string(), z.number()),
      pidsEvents: z.record(z.string(), z.number()),
      cpuStat: z.record(z.string(), z.number()),
    }),
  })
  .strict();
export const attestationSchema = z
  .object({
    id: z.uuid(),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    toolchainSha256: z.string().regex(/^[a-f0-9]{64}$/),
    bwrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
    seccompSha256: z.string().regex(/^[a-f0-9]{64}$/),
    kernel: z.string().max(200),
    bootId: z.string().max(100),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    probes: z.record(z.string(), z.object({ passed: z.literal(true), detail: z.string().max(1000) }).strict()),
  })
  .strict();
const envelope = {
  protocolVersion: z.literal(1),
  messageId: z.uuid(),
  workerId: z.uuid(),
  generation: z.number().int().positive(),
  sequence: z.number().int().positive(),
  sentAt: z.iso.datetime(),
};
export const remoteWorkerSchema = z
  .object({
    ...envelope,
    payload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("remote.hello"), attestation: attestationSchema }).strict(),
      z
        .object({
          type: z.literal("remote.output"),
          jobId: z.uuid(),
          files: manifestSchema,
          logs: logsSchema.optional(),
          result: metadataSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("remote.complete"),
          jobId: z.uuid(),
          manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({ type: z.literal("remote.failed"), jobId: z.uuid(), code: z.string().max(200), unknown: z.boolean() })
        .strict(),
    ]),
  })
  .strict();
export const remoteControlSchema = z
  .object({
    ...envelope,
    payload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("remote.cancel"), jobId: z.uuid(), reason: z.string().max(200) }).strict(),
      z
        .object({
          type: z.literal("remote.dispatch"),
          jobId: z.uuid(),
          scope: scopeSchema,
          action: toolActionSchema,
          request: requestSchema,
          files: manifestSchema,
          inputToken: z.string().min(32).max(200),
          expiresAt: z.iso.datetime(),
        })
        .strict(),
      z
        .object({
          type: z.literal("remote.upload"),
          jobId: z.uuid(),
          manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
          token: z.string().min(32).max(200),
          expiresAt: z.iso.datetime(),
        })
        .strict(),
    ]),
  })
  .strict();
export type RemoteWorkerMessage = z.infer<typeof remoteWorkerSchema>;
export type RemoteControlMessage = z.infer<typeof remoteControlSchema>;
export type RemoteResult = z.infer<typeof metadataSchema>;
export const stableId = (value: unknown) => {
  const s = hash(canonical(value));
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
};
export function assertControlSize(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CONTROL) throw new Error("control_message_limit");
}
