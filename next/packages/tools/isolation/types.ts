import type { Scope } from "../../contracts/src/index.ts";
export type ExecutionContext = {
  scope: Scope;
  orderId: string;
  authority: { kind: "tool"; actionId: string; targetId: string } | { kind: "ceo"; ceoId: string; requestId: string };
};
export interface ExecutionRequest {
  /** Trusted caller context. Never accepted from model/tool JSON. */
  context?: ExecutionContext;
  signal?: AbortSignal;
  workspaceRoot: string;
  argv: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Relative files/directories to export; default is the whole workspace. */
  outputPaths?: string[];
}
export type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  termination: "exited" | "timeout" | "output_limit" | "resource_limit" | "invalid_output" | "cancelled";
  attestationId: string;
  profileSha256: string;
  toolchainSha256: string;
  outputDirectory: string;
  outputHashes: Record<string, string>;
  resources: {
    memoryEvents: Record<string, number>;
    pidsEvents: Record<string, number>;
    cpuStat: Record<string, number>;
  };
};
export interface ExecutionPort {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
export interface IsolationProfile {
  version: 1;
  backend: "linux-bwrap-v1";
  bwrapPath: string;
  bwrapSha256: string;
  rootfs: string;
  toolchainSha256: string;
  seccompPath: string;
  seccompSha256: string;
  cgroupRoot: string;
  jobDirectory: string;
  commands: Record<string, string>;
  limits: {
    memoryBytes: number;
    workspaceBytes: number;
    pids: number;
    cpuQuotaMicros: number;
    cpuPeriodMicros: number;
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxLogBytes: number;
    maxFiles: number;
  };
}
export interface Attestation {
  id: string;
  profileSha256: string;
  toolchainSha256: string;
  bwrapSha256: string;
  seccompSha256: string;
  kernel: string;
  bootId: string;
  createdAt: string;
  expiresAt: string;
  probes: Record<string, { passed: boolean; detail: string }>;
}
export class IsolationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "IsolationError";
    this.code = code;
  }
}
