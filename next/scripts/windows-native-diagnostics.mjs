import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Diagnostic only. Every child keeps the production 15-second/8-KiB limits.
// No environment dump, user profile, service mutation, credentials or external target.
if (process.platform !== "win32") throw new Error("This diagnostic requires a real Windows host");
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
if (!path.win32.isAbsolute(systemRoot) || /[\r\n\0]/.test(systemRoot)) throw new Error("Invalid Windows system root");
const temporaryParent = process.env.RUNNER_TEMP ?? tmpdir();
if (!path.win32.isAbsolute(temporaryParent) || /[\r\n\0]/.test(temporaryParent))
  throw new Error("Invalid diagnostic temporary root");
const diagnosticDirectory = await mkdtemp(path.join(temporaryParent, "ironcrew-host-diagnostic-"));
const powershellHome = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
const executable = path.win32.join(powershellHome, "powershell.exe");
const minimalEnvironment = { SystemRoot: systemRoot, WINDIR: systemRoot };
const controlledEnvironment = {
  ...minimalEnvironment,
  TEMP: diagnosticDirectory,
  TMP: diagnosticDirectory,
  PSModulePath: path.win32.join(powershellHome, "Modules"),
};
const systemPathEnvironment = {
  ...controlledEnvironment,
  PATH: [
    path.win32.join(systemRoot, "System32"),
    path.win32.join(systemRoot, "System32", "Wbem"),
    powershellHome,
    systemRoot,
  ].join(";"),
};
// Copy only named, existing Windows metadata variables. Never copy a caller's search paths.
const selectEnvironment = (names) =>
  Object.fromEntries(
    names.flatMap((name) => (typeof process.env[name] === "string" ? [[name, process.env[name]]] : [])),
  );
const systemIdentityEnvironment = selectEnvironment([
  "COMSPEC",
  "SystemDrive",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ProgramData",
  "ALLUSERSPROFILE",
  "COMPUTERNAME",
  "OS",
]);
const profileArchitectureEnvironment = selectEnvironment([
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
]);
// Windows keys are case-insensitive; remove aliases before applying the fixed paths.
const controlledKeys = new Set(Object.keys(systemPathEnvironment).map((name) => name.toLowerCase()));
const inheritedWithSystemPaths = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !controlledKeys.has(name.toLowerCase()))),
  ...systemPathEnvironment,
};
const prelude = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()
function Phase([string]$name) {
  [Console]::WriteLine(('IRONCREW_PHASE {"name":"' + $name + '","elapsedMs":' + $elapsed.ElapsedMilliseconds + '}'))
}
Phase 'startup'
`;
const query = `
Phase 'queryStarted'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Select-Object Version,BuildNumber,ProductType,OperatingSystemSKU,Caption
Phase 'queryDone'
$os | ConvertTo-Json -Compress
`;
const explicitModule = `
Phase 'importStarted'
Import-Module -Name (Join-Path $PSHOME 'Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop
Phase 'importDone'
`;
const directModule = `
Phase 'importStarted'
Import-Module -Name ($PSHOME + '\\Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop
Phase 'importDone'
`;
const probes = [
  { name: "A-minimal-startup", env: minimalEnvironment, command: prelude + "Phase 'ready'" },
  { name: "B-original-cim-autoload", env: minimalEnvironment, command: prelude + query },
  {
    name: "C-controlled-temp-system-cim-module",
    env: controlledEnvironment,
    command: prelude + explicitModule + query,
  },
  {
    // Only PATH differs from C. This tests a dependency hypothesis, not an established cause.
    name: "D-controlled-system-path",
    env: systemPathEnvironment,
    command: prelude + explicitModule + query,
  },
  {
    // Only the module-path expression differs from D: no Join-Path cmdlet/autoload.
    name: "E-controlled-system-path-direct-module-expression",
    env: systemPathEnvironment,
    command: prelude + directModule + query,
  },
  {
    // Diagnostic control only, never a product environment policy or an environment dump.
    name: "F-original-query-inherited-runner-environment",
    env: process.env,
    command: prelude + query,
    inheritedEnvironment: true,
    onlyIfControlsFailed: true,
  },
  {
    name: "F2-inherited-runner-fixed-system-paths-direct-module",
    env: inheritedWithSystemPaths,
    command: prelude + directModule + query,
    inheritedEnvironment: true,
  },
  {
    // Exact B repetition after F/F2: distinguish environment changes from component warming.
    name: "B2-original-minimal-cim-autoload-after-inherited-controls",
    env: minimalEnvironment,
    command: prelude + query,
  },
  {
    name: "G-controlled-system-and-profile-architecture-whitelist",
    env: { ...systemPathEnvironment, ...systemIdentityEnvironment, ...profileArchitectureEnvironment },
    command: prelude + directModule + query,
  },
  {
    name: "H-controlled-system-identity-whitelist",
    env: { ...systemPathEnvironment, ...systemIdentityEnvironment },
    command: prelude + directModule + query,
  },
  {
    name: "I-controlled-profile-architecture-whitelist",
    env: { ...systemPathEnvironment, ...profileArchitectureEnvironment },
    command: prelude + directModule + query,
  },
];
const results = [];
const notRunProbes = [];
const failed = (result) => result.killed || result.signal || result.exitCode !== 0;
try {
  for (const probe of probes) {
    if (probe.onlyIfControlsFailed && results.some((result) => /^(D|E)-/.test(result.name) && !failed(result))) {
      notRunProbes.push({
        name: probe.name,
        reason: "A controlled D/E probe succeeded; inherited control unnecessary.",
      });
      continue;
    }
    const startedAt = new Date().toISOString();
    const start = performance.now();
    console.log(JSON.stringify({ probe: probe.name, event: "spawn", startedAt }));
    const result = await new Promise((resolve) => {
      const child = execFile(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", probe.command],
        { env: probe.env, timeout: 15000, maxBuffer: 8192, encoding: "utf8", windowsHide: true },
        (error, stdout, stderr) => {
          const phases = stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith("IRONCREW_PHASE "))
            .map((line) => {
              try {
                return JSON.parse(line.slice("IRONCREW_PHASE ".length));
              } catch {
                return { invalidPhaseOutput: line };
              }
            });
          resolve({
            name: probe.name,
            startedAt,
            durationMs: Math.round(performance.now() - start),
            environmentMode: probe.inheritedEnvironment ? "inherited-runner-diagnostic-only" : "controlled",
            ...(probe.inheritedEnvironment ? {} : { environmentKeys: Object.keys(probe.env) }),
            exitCode: error ? (error.code ?? null) : 0,
            killed: error?.killed ?? false,
            signal: error?.signal ?? null,
            phases,
            stdout,
            stderr,
          });
        },
      );
      // Emit only bounded fixed-command output as it arrives; keep timing before timeout visible.
      child.stdout?.on("data", (bytes) => {
        console.log(
          JSON.stringify({
            probe: probe.name,
            event: "stdout",
            elapsedMs: Math.round(performance.now() - start),
            text: bytes.toString(),
          }),
        );
      });
    });
    results.push(result);
    console.log(JSON.stringify({ probe: probe.name, event: "result", ...result }));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    timeoutMsPerProbe: 15000,
    maximumOutputBytesPerStream: 8192,
    scope:
      "Read-only diagnostic; ordered A-F/F2/B2/G/H/I probes may warm Windows components. D adds only system PATH to C; E removes only Join-Path from D; F conditionally contrasts B with inherited runner environment. F2 fixes system paths and directly imports the system Cim module with remaining inherited variables. B2 exactly repeats B after inherited controls to expose warming. G adds only named Windows system/profile/architecture variables to E; H and I split those groups. Inherited environments are never printed. No product fix or OS acceptance is inferred.",
    probes: results,
    notRunProbes,
  };
  const reportPath = path.resolve(".var/windows-native-diagnostics.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ event: "summary", ...report }));
  if (results.some(failed)) process.exitCode = 1;
} finally {
  await rm(diagnosticDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
