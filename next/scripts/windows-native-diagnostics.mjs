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
const probes = [
  { name: "A-minimal-startup", env: minimalEnvironment, command: prelude + "Phase 'ready'" },
  { name: "B-original-cim-autoload", env: minimalEnvironment, command: prelude + query },
  {
    name: "C-controlled-temp-system-cim-module",
    env: controlledEnvironment,
    command:
      prelude +
      `
Phase 'importStarted'
Import-Module -Name (Join-Path $PSHOME 'Modules\\CimCmdlets\\CimCmdlets.psd1') -ErrorAction Stop
Phase 'importDone'
` +
      query,
  },
];
const results = [];
try {
  for (const probe of probes) {
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
            environmentKeys: Object.keys(probe.env),
            exitCode: error?.code ?? 0,
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
      "Read-only diagnostic; ordered A/B/C probes may warm Windows components. No product fix or OS acceptance is inferred.",
    probes: results,
  };
  const reportPath = path.resolve(".var/windows-native-diagnostics.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ event: "summary", ...report }));
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
} finally {
  await rm(diagnosticDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
