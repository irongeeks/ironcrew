import { isVerifiedRemotePort } from "../remote-execution/port.ts";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, lstat, realpath, open, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { gateSource, supervisorSource } from "./assets.ts";
import { randomUUID } from "node:crypto";
import { release } from "node:os";
import {
  IsolationError,
  type IsolationProfile,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
  type Attestation,
} from "./types.ts";
import { hash, canonical, treeHash, snapshot, safeRelative } from "./files.ts";
import { attest } from "./probes.ts";
export * from "./types.ts";
const verified = new WeakSet<object>();
export const isVerifiedExecutionPort = (port: unknown): port is ExecutionPort =>
  !!port && typeof port === "object" && (verified.has(port) || isVerifiedRemotePort(port));

function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new IsolationError(code);
}
export class LinuxIsolation implements ExecutionPort {
  readonly profile: IsolationProfile;
  readonly attestation: Attestation;
  private busy = false;
  private constructor(profile: IsolationProfile, attestation: Attestation) {
    this.profile = Object.freeze({
      ...structuredClone(profile),
      commands: Object.freeze({ ...profile.commands }),
      limits: Object.freeze({ ...profile.limits }),
    });
    this.attestation = structuredClone(attestation);
    Object.defineProperty(this, "profile", { writable: false, configurable: false });
    Object.defineProperty(this, "attestation", { writable: false, configurable: false });
  }
  static async create(profile: IsolationProfile): Promise<LinuxIsolation> {
    if (process.platform !== "linux") throw new IsolationError("isolation_platform_unsupported");
    requireValue(process.getuid?.() !== 0, "unprivileged_worker_required");
    requireValue(profile?.version === 1 && profile.backend === "linux-bwrap-v1", "isolation_profile_invalid");
    for (const name of ["bwrapPath", "rootfs", "seccompPath", "cgroupRoot", "jobDirectory"] as const)
      requireValue(
        typeof profile[name] === "string" && path.isAbsolute(profile[name]) && !profile[name].includes("\0"),
        "isolation_profile_invalid",
      );
    requireValue(
      profile.cgroupRoot.startsWith("/sys/fs/cgroup/") && profile.cgroupRoot !== "/sys/fs/cgroup/",
      "cgroup_delegation_required",
    );
    const limits = profile.limits;
    for (const value of Object.values(limits ?? {}))
      requireValue(Number.isSafeInteger(value) && value > 0, "isolation_limits_invalid");
    requireValue(
      limits &&
        limits.memoryBytes >= 64_000_000 &&
        limits.memoryBytes <= 4_294_967_296 &&
        limits.workspaceBytes <= limits.memoryBytes &&
        limits.pids >= 24 &&
        limits.pids <= 512 &&
        limits.timeoutMs <= 600_000 &&
        limits.maxFiles <= 20000 &&
        limits.maxInputBytes <= 268_435_456 &&
        limits.maxOutputBytes <= 134_217_728 &&
        limits.maxLogBytes <= 4_000_000 &&
        limits.cpuQuotaMicros <= limits.cpuPeriodMicros * 2,
      "isolation_limits_invalid",
    );
    requireValue(profile.commands?.node === "/usr/local/bin/node", "node_toolchain_required");
    for (const [name, target] of Object.entries(profile.commands))
      requireValue(
        /^[a-z][a-z0-9-]{0,39}$/.test(name) &&
          path.isAbsolute(target) &&
          !target.includes("..") &&
          !target.includes("\0"),
        "isolation_commands_invalid",
      );
    await verifyProfile(profile);
    const identity = {
      id: randomUUID(),
      profileSha256: hash(canonical(profile)),
      toolchainSha256: profile.toolchainSha256,
      bwrapSha256: profile.bwrapSha256,
      seccompSha256: profile.seccompSha256,
      kernel: release(),
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      probes: {},
    } satisfies Attestation;
    const runner = new LinuxIsolation(profile, identity);
    const probes = await attest(profile, (request, override) => runner.run(request, override));
    requireValue(
      Object.values(probes).every((probe) => probe.passed),
      "isolation_probes_failed",
    );
    runner.attestation.probes = Object.freeze(
      Object.fromEntries(Object.entries(probes).map(([key, value]) => [key, Object.freeze(value)])),
    );
    Object.freeze(runner.attestation);
    verified.add(runner);
    return runner;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    requireValue(
      verified.has(this) &&
        Date.parse(this.attestation.expiresAt) > Date.now() &&
        hash(canonical(this.profile)) === this.attestation.profileSha256,
      "isolation_profile_unverified",
    );
    requireValue(!this.busy, "isolation_busy");
    this.busy = true;
    try {
      await verifyProfile(this.profile);
      requireValue(
        (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() === this.attestation.bootId,
        "isolation_boot_changed",
      );
      return await this.run(request);
    } finally {
      this.busy = false;
    }
  }
  private async run(
    request: ExecutionRequest,
    override?: Partial<IsolationProfile["limits"]>,
  ): Promise<ExecutionResult> {
    request.signal?.throwIfAborted();
    const p = this.profile,
      limits = { ...p.limits, ...override };
    requireValue(
      Array.isArray(request.argv) &&
        request.argv.length > 0 &&
        request.argv.length <= 128 &&
        request.argv.every((arg) => typeof arg === "string" && !arg.includes("\0") && arg.length <= 65536),
      "execution_arguments_invalid",
    );
    const executable = p.commands[request.argv[0]!];
    requireValue(executable, "execution_tool_unavailable");
    const outputPaths = request.outputPaths ?? ["."];
    requireValue(
      Array.isArray(outputPaths) &&
        outputPaths.length <= 64 &&
        outputPaths.every((item) => item === "." || safeRelative(item)),
      "execution_output_path_invalid",
    );
    const timeout = request.timeoutMs ?? limits.timeoutMs,
      maxOutput = request.maxOutputBytes ?? limits.maxOutputBytes;
    requireValue(
      Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        timeout <= limits.timeoutMs &&
        Number.isSafeInteger(maxOutput) &&
        maxOutput > 0 &&
        maxOutput <= limits.maxOutputBytes,
      "execution_limits_invalid",
    );
    await mkdir(p.jobDirectory, { recursive: true, mode: 0o700 });
    requireValue((await realpath(p.jobDirectory)) === p.jobDirectory, "unsafe_job_directory");
    const job = await mkdtemp(path.join(p.jobDirectory, "job-")),
      input = path.join(job, "input"),
      outputDirectory = path.join(job, "output"),
      cgroup = path.join(p.cgroupRoot, path.basename(job));
    await mkdir(input, { mode: 0o700 });
    await mkdir(outputDirectory, { mode: 0o700 });
    try {
      await snapshot(request.workspaceRoot, input, limits);
    } catch (error) {
      await rm(job, { recursive: true, force: true });
      throw error;
    }
    await writeFile(path.join(job, "gate.mjs"), gateSource, { mode: 0o600 });
    await writeFile(path.join(job, "supervisor.mjs"), supervisorSource, { mode: 0o600 });
    await writeFile(
      path.join(job, "request.json"),
      JSON.stringify({
        command: executable,
        argv: request.argv.slice(1),
        outputPaths,
        maxOutputBytes: maxOutput,
        maxFiles: limits.maxFiles,
      }),
      { mode: 0o600 },
    );
    await mkdir(cgroup, { mode: 0o700 });
    let stdout = "",
      stderr = "",
      wire = "",
      termination: ExecutionResult["termination"] = "exited",
      exitCode = 1;
    let resources: ExecutionResult["resources"] = { memoryEvents: {}, pidsEvents: {}, cpuStat: {} };
    const kill = async () => {
      try {
        await writeFile(path.join(cgroup, "cgroup.kill"), "1");
      } catch {
        /* A completed group has no remaining processes. */
      }
    };
    const abort = () => {
      termination = "cancelled";
      void kill();
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    try {
      for (const [file, value] of Object.entries({
        "memory.max": limits.memoryBytes,
        "memory.swap.max": 0,
        "memory.oom.group": 1,
        "pids.max": limits.pids,
        "cpu.max": `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`,
      }))
        await writeFile(path.join(cgroup, file), String(value));
      const filter = await open(p.seccompPath, "r");
      const args = [
        "--unshare-all",
        "--unshare-user",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--disable-userns",
        "--clearenv",
        "--ro-bind",
        p.rootfs,
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--size",
        String(limits.workspaceBytes),
        "--tmpfs",
        "/workspace",
        "--size",
        String(Math.min(limits.workspaceBytes, 128_000_000)),
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        input,
        "/input",
        "--ro-bind",
        path.join(job, "request.json"),
        "/run/ironcrew-request.json",
        "--ro-bind",
        path.join(job, "supervisor.mjs"),
        "/run/ironcrew-supervisor.mjs",
        "--chdir",
        "/workspace",
        "--setenv",
        "PATH",
        "/usr/local/bin:/usr/bin:/bin",
        "--setenv",
        "LANG",
        "C.UTF-8",
        "--seccomp",
        "4",
        "--",
        "/usr/local/bin/node",
        "/run/ironcrew-supervisor.mjs",
      ];
      try {
        exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(job, "gate.mjs")], {
            env: { LANG: "C.UTF-8", TZ: "UTC" },
            shell: false,
            stdio: ["pipe", "pipe", "pipe", "pipe", filter.fd],
          });
          let completed = false,
            logBytes = 0,
            wireBytes = 0;
          const timer = setTimeout(() => {
            termination = "timeout";
            void kill();
          }, timeout);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.stdin!.on("error", (error) => {
            if (!completed) {
              clearTimeout(timer);
              child.kill("SIGKILL");
              void kill();
              reject(error);
            }
          });
          const log = (which: "stdout" | "stderr", chunk: Buffer) => {
            logBytes += Math.max(chunk.length, Buffer.byteLength(chunk.toString()));
            if (logBytes > limits.maxLogBytes) {
              termination = "output_limit";
              void kill();
              return;
            }
            if (which === "stdout") stdout += chunk.toString();
            else stderr += chunk.toString();
          };
          child.stdout!.on("data", (chunk: Buffer) => log("stdout", chunk));
          child.stderr!.on("data", (chunk: Buffer) => log("stderr", chunk));
          (child.stdio[3] as import("node:stream").Readable).on("data", (chunk: Buffer) => {
            wireBytes += chunk.length;
            if (wireBytes > maxOutput * 1.5 + limits.maxFiles * 300 + 4096) {
              termination = "output_limit";
              void kill();
              return;
            }
            wire += chunk.toString();
          });
          child.once("close", (code) => {
            completed = true;
            clearTimeout(timer);
            resolve(code ?? 137);
          });
          void (async () => {
            try {
              requireValue(child.pid, "process_start_failed");
              await writeFile(path.join(cgroup, "cgroup.procs"), String(child.pid));
              if (request.signal?.aborted) {
                await kill();
                child.stdin!.destroy();
                return;
              }
              if (!completed) child.stdin!.end(JSON.stringify({ go: true, executable: p.bwrapPath, argv: args }));
            } catch (error) {
              child.stdin!.destroy();
              child.kill("SIGKILL");
              clearTimeout(timer);
              void kill();
              reject(error);
            }
          })();
        });
      } finally {
        await filter.close();
      }
      await kill();
      resources = {
        memoryEvents: await counters(cgroup, "memory.events"),
        pidsEvents: await counters(cgroup, "pids.events"),
        cpuStat: await counters(cgroup, "cpu.stat"),
      };
      if ((resources.memoryEvents.oom_kill ?? 0) > 0) termination = "resource_limit";
      const outputHashes: Record<string, string> = {};
      if (termination === "exited") {
        try {
          const result = JSON.parse(wire) as {
            version: number;
            exitCode: number;
            error?: string;
            files: { path: string; base64: string }[];
          };
          requireValue(
            result.version === 1 &&
              Number.isInteger(result.exitCode) &&
              result.exitCode >= 0 &&
              result.exitCode <= 255 &&
              Array.isArray(result.files) &&
              result.files.length <= limits.maxFiles &&
              !result.error,
            "invalid_output",
          );
          let bytes = 0;
          for (const file of result.files) {
            requireValue(
              safeRelative(file.path) && typeof file.base64 === "string" && !(file.path in outputHashes),
              "invalid_output",
            );
            const data = Buffer.from(file.base64, "base64");
            requireValue(
              data.toString("base64") === file.base64 && (bytes += data.length) <= maxOutput,
              "invalid_output",
            );
            await mkdir(path.dirname(path.join(outputDirectory, file.path)), { recursive: true, mode: 0o700 });
            const handle = await open(path.join(outputDirectory, file.path), "wx", 0o600);
            try {
              await handle.writeFile(data);
            } finally {
              await handle.close();
            }
            outputHashes[file.path] = hash(data);
          }
          exitCode = result.exitCode;
        } catch {
          termination = "invalid_output";
          for (const key of Object.keys(outputHashes)) delete outputHashes[key];
          exitCode = 125;
          await rm(outputDirectory, { recursive: true, force: true });
          await mkdir(outputDirectory, { mode: 0o700 });
        }
      }
      return {
        exitCode,
        stdout,
        stderr,
        termination,
        attestationId: this.attestation.id,
        profileSha256: this.attestation.profileSha256,
        toolchainSha256: p.toolchainSha256,
        outputDirectory,
        outputHashes,
        resources,
      };
    } finally {
      request.signal?.removeEventListener("abort", abort);
      await kill();
      await removeEmptyCgroup(cgroup);
      await rm(input, { recursive: true, force: true });
      await rm(path.join(job, "request.json"), { force: true });
    }
  }
}
async function removeEmptyCgroup(cgroup: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await counters(cgroup, "cgroup.events")).populated === 0) {
      await rmdir(cgroup);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new IsolationError("isolation_cleanup_failed");
}
async function counters(root: string, file: string) {
  return Object.fromEntries(
    (await readFile(path.join(root, file), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(/\s+/);
        return [key!, Number(value)];
      }),
  );
}
async function verifyProfile(p: IsolationProfile) {
  requireValue(
    (await lstat(p.bwrapPath)).isFile() && ((await lstat(p.bwrapPath)).mode & 0o6022) === 0,
    "unsafe_bwrap_binary",
  );
  requireValue(
    hash(await readFile(p.bwrapPath)) === p.bwrapSha256 && hash(await readFile(p.seccompPath)) === p.seccompSha256,
    "isolation_binary_changed",
  );
  requireValue(
    (await realpath(p.rootfs)) === p.rootfs && (await treeHash(p.rootfs)) === p.toolchainSha256,
    "isolation_toolchain_changed",
  );
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(p.bwrapPath, ["--version"], { env: { LANG: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new IsolationError("bwrap_unavailable")),
    );
  });
  requireValue(/^bubblewrap 0\.12\.0$/.test(version), "bwrap_version_unverified");
  const membership = (await readFile("/proc/self/cgroup", "utf8")).trim();
  const delegatedRelative = p.cgroupRoot.slice("/sys/fs/cgroup".length);
  requireValue(membership.startsWith("0::" + delegatedRelative + "/"), "worker_outside_delegated_cgroup");
  const controllers = (await readFile(path.join(p.cgroupRoot, "cgroup.controllers"), "utf8")).split(/\s+/);
  requireValue(
    ["memory", "pids", "cpu"].every((controller) => controllers.includes(controller)),
    "cgroup_controllers_missing",
  );
  const enabled = (await readFile(path.join(p.cgroupRoot, "cgroup.subtree_control"), "utf8")).split(/\s+/);
  requireValue(
    ["memory", "pids", "cpu"].every((controller) => enabled.includes(controller)),
    "cgroup_delegation_required",
  );
}

export async function loadExecutionPort(profilePath: string): Promise<LinuxIsolation> {
  return LinuxIsolation.create(JSON.parse(await readFile(profilePath, "utf8")) as IsolationProfile);
}
