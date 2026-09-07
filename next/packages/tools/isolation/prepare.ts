import { mkdir, readFile, writeFile, cp, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { seccompSource, syscallProbeSource } from "./assets.ts";
import { hash, treeHash } from "./files.ts";
import { IsolationError, type IsolationProfile } from "./types.ts";
async function command(executable: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => (output += String(data)));
    child.stderr.on("data", (data) => (output += String(data)));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}
/** An explicit admin provisioning operation; never invoked implicitly by execution or attestation. */
export async function prepareProfile(input: {
  directory: string;
  nodeDistribution: string;
  bwrapPath: string;
  cgroupRoot: string;
  phpPath?: string;
}): Promise<IsolationProfile> {
  if (process.platform !== "linux") throw new IsolationError("isolation_platform_unsupported");
  const directory = path.resolve(input.directory),
    rootfs = path.join(directory, "rootfs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(rootfs, { mode: 0o700 });
  for (const item of [
    "usr/local",
    "usr/bin",
    "bin",
    "lib",
    "lib64",
    "etc",
    "proc",
    "dev",
    "sys",
    "run",
    "input",
    "workspace",
    "tmp",
  ])
    await mkdir(path.join(rootfs, item), { recursive: true, mode: 0o755 });
  for (const name of ["ironcrew-request.json", "ironcrew-supervisor.mjs"])
    await writeFile(path.join(rootfs, "run", name), "");
  await cp(await realpath(input.nodeDistribution), path.join(rootfs, "usr/local"), {
    recursive: true,
    dereference: false,
  });
  const binaries = [
    path.join(input.nodeDistribution, "bin/node"),
    "/usr/bin/busybox",
    "/usr/bin/unshare",
    ...(input.phpPath ? [input.phpPath] : []),
  ];
  const copied = new Set<string>();
  async function copyLibrary(source: string, destination = source) {
    if (copied.has(destination)) return;
    copied.add(destination);
    await mkdir(path.dirname(path.join(rootfs, destination)), { recursive: true, mode: 0o755 });
    await cp(await realpath(source), path.join(rootfs, destination));
  }
  for (const binary of binaries) {
    const dependencyOutput = await command("/usr/bin/ldd", [binary]).catch((error) => {
      if (binary.endsWith("/busybox")) return "";
      throw error;
    });
    for (const match of dependencyOutput.matchAll(/(?:=>\s+)?(\/[A-Za-z0-9_./+-]+)/g)) await copyLibrary(match[1]!);
  }
  await copyLibrary("/usr/bin/busybox", "/bin/busybox");
  for (const name of ["sh", "sleep", "env"])
    await cp("/usr/bin/busybox", path.join(rootfs, name === "env" ? "usr/bin/env" : "bin/" + name));
  await copyLibrary("/usr/bin/unshare");
  if (input.phpPath) {
    await copyLibrary(input.phpPath, "/usr/bin/php");
    await mkdir(path.join(rootfs, "usr/share"), { recursive: true, mode: 0o755 });
    await cp("/usr/share/zoneinfo", path.join(rootfs, "usr/share/zoneinfo"), { recursive: true, dereference: true });
  }
  await writeFile(
    path.join(rootfs, "etc/passwd"),
    `sandbox:x:${process.getuid!()}:${process.getgid!()}::/tmp/home:/bin/sh\n`,
  );
  await writeFile(path.join(rootfs, "etc/group"), `sandbox:x:${process.getgid!()}:\n`);
  await writeFile(path.join(directory, "seccomp.c"), seccompSource);
  await command("/usr/bin/cc", [
    "-Wall",
    "-Werror",
    "-O2",
    path.join(directory, "seccomp.c"),
    "-o",
    path.join(directory, "seccomp-compiler"),
  ]);
  await writeFile(path.join(directory, "syscall-probe.c"), syscallProbeSource);
  await command("/usr/bin/cc", [
    "-Wall",
    "-Werror",
    "-O2",
    path.join(directory, "syscall-probe.c"),
    "-o",
    path.join(rootfs, "usr/local/bin/isolation-probe"),
  ]);
  const seccompPath = path.join(directory, "seccomp.bpf");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(path.join(directory, "seccomp-compiler"), [], {
      env: { LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => chunks.push(data));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new IsolationError("seccomp_compile_failed"));
      writeFile(seccompPath, Buffer.concat(chunks), { mode: 0o400 }).then(() => resolve(), reject);
    });
  });
  const commands: Record<string, string> = {
    node: "/usr/local/bin/node",
    sh: "/bin/sh",
    ...(input.phpPath ? { php: "/usr/bin/php" } : {}),
  };
  const profile: IsolationProfile = {
    version: 1,
    backend: "linux-bwrap-v1",
    bwrapPath: await realpath(input.bwrapPath),
    bwrapSha256: hash(await readFile(input.bwrapPath)),
    rootfs,
    toolchainSha256: await treeHash(rootfs),
    seccompPath,
    seccompSha256: hash(await readFile(seccompPath)),
    cgroupRoot: input.cgroupRoot,
    jobDirectory: path.join(directory, "jobs"),
    commands,
    limits: {
      memoryBytes: 536_870_912,
      workspaceBytes: 268_435_456,
      pids: 96,
      cpuQuotaMicros: 100000,
      cpuPeriodMicros: 100000,
      timeoutMs: 300000,
      maxInputBytes: 67_108_864,
      maxOutputBytes: 67_108_864,
      maxLogBytes: 1_000_000,
      maxFiles: 10000,
    },
  };
  await writeFile(path.join(directory, "profile.json"), JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  // Prepared hashes are configuration, never an attestation. create()/loadExecutionPort() must still run all probes.
  return profile;
}
