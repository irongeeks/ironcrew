import { mkdtemp, writeFile, readFile, rm, mkdir, readlink } from "node:fs/promises";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  IsolationError,
  type IsolationProfile,
  type ExecutionRequest,
  type ExecutionResult,
  type Attestation,
} from "./types.ts";
type ProbeRunner = (
  request: ExecutionRequest,
  limits?: Partial<IsolationProfile["limits"]>,
) => Promise<ExecutionResult>;
/** Known adversarial programs must fail at real kernel boundaries before any generated program is admitted. */
export async function attest(profile: IsolationProfile, run: ProbeRunner): Promise<Attestation["probes"]> {
  await mkdir(profile.jobDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(profile.jobDirectory, "attest-")),
    workspace = path.join(directory, "workspace"),
    canary = path.join(directory, "outside-secret"),
    secret = randomUUID();
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(canary, secret, { mode: 0o600 });
  const probes: Attestation["probes"] = {};
  const record = (name: string, passed: boolean, detail: string) => {
    probes[name] = { passed, detail };
    if (!passed) throw new IsolationError("isolation_probe_failed:" + name + ":" + detail);
  };
  const execute = (code: string, limits?: Partial<IsolationProfile["limits"]>, timeoutMs = 5000) =>
    run({ workspaceRoot: workspace, argv: ["node", "-e", code], timeoutMs, outputPaths: ["."] }, limits);
  let connected = false;
  const server = createServer((socket) => {
    connected = true;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const hostNamespaces = Object.fromEntries(
      await Promise.all(
        ["user", "mnt", "pid", "net", "ipc", "uts", "cgroup"].map(async (name) => [
          name,
          await readlink("/proc/self/ns/" + name),
        ]),
      ),
    );
    const inspect = await execute(
      `const fs=require('node:fs');const names=['user','mnt','pid','net','ipc','uts','cgroup'];console.log(JSON.stringify({nodeVersion:process.version,namespaces:Object.fromEntries(names.map(name=>[name,fs.readlinkSync('/proc/self/ns/'+name)])),status:fs.readFileSync('/proc/self/status','utf8'),env:process.env}));`,
    );
    record(
      "trusted_program_runs",
      inspect.exitCode === 0 && inspect.termination === "exited",
      inspect.stderr.slice(0, 500) || inspect.termination,
    );
    const observed = JSON.parse(inspect.stdout.trim()) as {
      nodeVersion: string;
      namespaces: Record<string, string>;
      status: string;
      env: Record<string, string>;
    };
    record("node_version", observed.nodeVersion === "v26.4.0", observed.nodeVersion);
    if (profile.commands.php) {
      const php = await run({
        workspaceRoot: workspace,
        argv: ["php", "-n", "-r", "echo PHP_VERSION;"],
        outputPaths: [],
        timeoutMs: 5000,
      });
      record(
        "php_toolchain",
        php.exitCode === 0 && /^8\.[3-9]\.\d+$/.test(php.stdout.trim()),
        "PHP " + php.stdout.trim() + php.stderr.slice(0, 100),
      );
    }
    const syscallProbe = await execute(
      "const p=require('node:child_process').spawnSync('/usr/local/bin/isolation-probe',[],{encoding:'utf8'});process.stdout.write(p.stdout);process.exitCode=p.status;",
    );
    record(
      "seccomp_syscall",
      syscallProbe.exitCode === 0 && syscallProbe.stdout.trim() === "denied",
      "self process_vm_readv, otherwise permitted, returns EPERM",
    );
    record(
      "kernel_namespaces",
      Object.entries(hostNamespaces).every(([name, value]) => observed.namespaces[name] !== value),
      "mount/user/pid/net/ipc/uts/cgroup namespaces differ from supervisor",
    );
    record(
      "capabilities_seccomp",
      /^CapEff:\s*0+$/m.test(observed.status) &&
        /^NoNewPrivs:\s*1$/m.test(observed.status) &&
        /^Seccomp:\s*2$/m.test(observed.status),
      "kernel reports zero effective capabilities, no_new_privs and seccomp filter",
    );
    record(
      "environment",
      Object.keys(observed.env).every((key) =>
        [
          "PATH",
          "HOME",
          "TMPDIR",
          "LANG",
          "TZ",
          "NODE_OPTIONS",
          "npm_config_offline",
          "npm_config_audit",
          "npm_config_fund",
          "npm_config_cache",
        ].includes(key),
      ),
      "only the rebuilt execution allowlist exists",
    );
    const filesystem = await execute(
      `const fs=require('node:fs');let denied=0;for(const name of ${JSON.stringify([canary, "/etc/shadow", "/root/.ssh/id_rsa", "/run/docker.sock", "/var/run/docker.sock"])}){try{fs.readFileSync(name)}catch{denied++}}try{fs.writeFileSync(${JSON.stringify(canary)},'overwrite')}catch{denied++}try{fs.writeFileSync('/usr/local/bin/node','overwrite')}catch{denied++}console.log(denied);`,
    );
    record(
      "filesystem",
      filesystem.exitCode === 0 &&
        Number(filesystem.stdout.trim()) === 7 &&
        (await readFile(canary, "utf8")) === secret,
      "host secrets, runtime sockets and toolchain writes are inaccessible",
    );
    const network = await execute(
      `const net=require('node:net');const socket=net.connect({host:'127.0.0.1',port:${port}});socket.setTimeout(1000);socket.once('connect',()=>{console.log('connected');socket.destroy()});socket.once('error',()=>console.log('denied'));socket.once('timeout',()=>{console.log('denied');socket.destroy()});`,
    );
    record(
      "network",
      network.exitCode === 0 && network.stdout.trim() === "denied" && !connected,
      "host loopback listener received no connection",
    );
    const processIsolation = await execute(
      `let denied=false;try{process.kill(${process.pid},0)}catch{denied=true}console.log(denied?'denied':'visible');`,
    );
    record(
      "host_process",
      processIsolation.exitCode === 0 && processIsolation.stdout.trim() === "denied",
      "host supervisor PID is inaccessible from the workload PID namespace",
    );
    const spawnLimit = await execute(
      `const {spawn}=require('node:child_process');let denied=0;const children=[];for(let i=0;i<100;i++){const child=spawn('/bin/sh',['-c','sleep 30']);children.push(child);child.on('error',()=>{denied++})}setTimeout(()=>{for(const child of children)child.kill('SIGKILL');console.log(denied)},500);`,
      { pids: 48 },
    );
    record(
      "process_limit",
      (spawnLimit.resources.pidsEvents.max ?? 0) > 0,
      "cgroup pids.events confirms denied process creation",
    );
    const memory = await execute(
      `const items=[];setInterval(()=>{const b=Buffer.alloc(8*1024*1024,1);items.push(b)},1);`,
      { memoryBytes: 128_000_000, workspaceBytes: 32_000_000, pids: 48 },
      3000,
    );
    record(
      "memory_limit",
      memory.termination === "resource_limit" && (memory.resources.memoryEvents.oom_kill ?? 0) > 0,
      "kernel memory.events confirms the workload was OOM-killed inside its group",
    );
    const cpu = await execute("while(true){}", { cpuQuotaMicros: 25000, cpuPeriodMicros: 100000 }, 900);
    record(
      "cpu_timeout",
      cpu.termination === "timeout" && (cpu.resources.cpuStat.nr_throttled ?? 0) > 0,
      "CPU quota throttled the workload and wall-time cancellation killed its cgroup",
    );
    const output = await execute(`while(true)process.stdout.write('x'.repeat(65536));`, { maxLogBytes: 8192 }, 3000);
    record(
      "output_limit",
      output.termination === "output_limit" &&
        Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 8192,
      "unbounded logs are killed without unbounded supervisor buffering",
    );
    const disk = await execute(
      `const fs=require('node:fs');const fd=fs.openSync('/workspace/fill','w');try{for(let i=0;i<128;i++)fs.writeSync(fd,Buffer.alloc(1024*1024,1));console.log('overflow')}catch(e){console.log(e.code)}finally{fs.closeSync(fd);fs.unlinkSync('/workspace/fill')}`,
      { workspaceBytes: 16_000_000 },
      3000,
    );
    record(
      "workspace_quota",
      disk.exitCode === 0 && disk.stdout.trim() === "ENOSPC",
      "workspace tmpfs rejects writes above its independent size limit",
    );
    const symlink = await execute(`require('node:fs').symlinkSync('/etc/shadow','escape');`);
    record(
      "symlink_export",
      symlink.termination === "invalid_output" && Object.keys(symlink.outputHashes).length === 0,
      "symlink outputs are rejected before any host import",
    );
    const nested = await execute(
      `const {spawnSync}=require('node:child_process');const result=spawnSync('/usr/bin/unshare',['--user','/bin/sh','-c','echo escaped'],{encoding:'utf8'});console.log(result.status!==0?'denied':'escaped');`,
    );
    record(
      "nested_namespace",
      nested.exitCode === 0 && nested.stdout.trim() === "denied",
      "nested namespace creation remains denied by seccomp and userns policy",
    );
    return probes;
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
