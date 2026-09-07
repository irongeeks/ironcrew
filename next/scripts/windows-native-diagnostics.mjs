import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Diagnostic only: fixed local OS queries, no environment values or cache contents are printed.
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
  PATH: [
    path.win32.join(systemRoot, "System32"),
    path.win32.join(systemRoot, "System32", "Wbem"),
    powershellHome,
    systemRoot,
  ].join(";"),
};
const controlledKeys = new Set(Object.keys(controlledEnvironment).map((name) => name.toLowerCase()));
const inheritedWithSystemPaths = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !controlledKeys.has(name.toLowerCase()))),
  ...controlledEnvironment,
};
const fields = ["Version", "BuildNumber", "ProductType", "OperatingSystemSKU", "Caption"];
const prelude = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()
function Phase([string]$name) {
  [Console]::WriteLine(('IRONCREW_PHASE {"name":"' + $name + '","elapsedMs":' + $elapsed.ElapsedMilliseconds + '}'))
}
Phase 'startup'
`;
const cimQuery = `
Phase 'queryStarted'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Select-Object Version,BuildNumber,ProductType,OperatingSystemSKU,Caption
Phase 'queryDone'
$os | ConvertTo-Json -Compress
`;
const directModule = String.raw`
Phase 'importStarted'
Import-Module -Name ($PSHOME + '\Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
Phase 'importDone'
`;
// Same local Win32_OperatingSystem provider and five fields; no PowerShell module or serializer.
const nativeQuery = String.raw`
Phase 'queryStarted'
$searcher = [wmisearcher]'SELECT Version,BuildNumber,ProductType,OperatingSystemSKU,Caption FROM Win32_OperatingSystem'
$searcher.Scope.Path = '\\.\root\cimv2'
try {
  $records = $searcher.Get()
  try {
    if ($records.Count -ne 1) { throw 'Expected exactly one operating system record' }
    foreach ($os in $records) {
      try {
        foreach ($field in @('Version','BuildNumber','ProductType','OperatingSystemSKU','Caption')) {
          $value = [string]$os.Properties[$field].Value
          if ([string]::IsNullOrEmpty($value)) { throw 'Missing operating system field' }
          [Console]::WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($value)))
        }
      } finally { $os.Dispose() }
    }
  } finally { $records.Dispose() }
} finally { $searcher.Dispose() }
Phase 'queryDone'
`;
const probes = [
  { name: "A-minimal-startup", env: minimalEnvironment, command: prelude + "Phase 'ready'", format: "startup" },
  { name: "B-original-cim-autoload", env: minimalEnvironment, command: prelude + cimQuery, format: "json" },
  {
    name: "O-native-wmi-minimal-environment",
    env: minimalEnvironment,
    command: prelude + nativeQuery,
    format: "base64-five-lines",
  },
  {
    name: "O2-native-wmi-controlled-environment",
    env: controlledEnvironment,
    command: prelude + nativeQuery,
    format: "base64-five-lines",
  },
  {
    name: "F2-inherited-cached-control-fixed-paths",
    env: inheritedWithSystemPaths,
    command: prelude + directModule + cimQuery,
    format: "json",
    inheritedEnvironment: true,
  },
];
const results = [];
const failed = (result) => result.killed || result.signal || result.exitCode !== 0 || !result.completed;
try {
  const cachePath = process.env.PSModuleAnalysisCachePath;
  const cacheMetadata = {
    variablePresent: typeof cachePath === "string",
    absolute: typeof cachePath === "string" && path.win32.isAbsolute(cachePath),
  };
  if (typeof cachePath === "string") {
    try {
      const info = await stat(cachePath);
      Object.assign(cacheMetadata, {
        exists: true,
        regularFile: info.isFile(),
        directory: info.isDirectory(),
        bytes: info.size,
      });
    } catch (error) {
      Object.assign(cacheMetadata, {
        exists: error.code === "ENOENT" ? false : null,
        errorCode: error.code ?? "unknown",
      });
    }
  }
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
          const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
          const phases = lines
            .filter((line) => line.startsWith("IRONCREW_PHASE "))
            .map((line) => {
              try {
                return JSON.parse(line.slice("IRONCREW_PHASE ".length));
              } catch {
                return { invalidPhaseOutput: true };
              }
            });
          const payload = lines.filter((line) => !line.startsWith("IRONCREW_PHASE "));
          let completed = probe.format === "startup" && phases.some((phase) => phase.name === "ready");
          let hostFields;
          try {
            if (probe.format === "base64-five-lines" && payload.length === fields.length) {
              hostFields = Object.fromEntries(
                fields.map((field, index) => {
                  const bytes = Buffer.from(payload[index], "base64");
                  if (bytes.toString("base64") !== payload[index]) throw new Error("Invalid field encoding");
                  return [field, new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
                }),
              );
            } else if (probe.format === "json" && payload.length === 1) hostFields = JSON.parse(payload[0]);
            if (hostFields)
              completed =
                phases.some((phase) => phase.name === "queryDone") &&
                fields.every(
                  (field) =>
                    ["string", "number"].includes(typeof hostFields[field]) && String(hostFields[field]).length > 0,
                );
          } catch {
            completed = false;
          }
          resolve({
            name: probe.name,
            startedAt,
            durationMs: Math.round(performance.now() - start),
            environmentMode: probe.inheritedEnvironment ? "inherited-runner-diagnostic-only" : "controlled",
            ...(probe.inheritedEnvironment ? {} : { environmentKeys: Object.keys(probe.env) }),
            exitCode: error ? (error.code ?? null) : 0,
            killed: error?.killed ?? false,
            signal: error?.signal ?? null,
            completed,
            phases,
            hostFields,
            stdout,
            stderr,
          });
        },
      );
      child.stdout?.on("data", (bytes) =>
        console.log(
          JSON.stringify({
            probe: probe.name,
            event: "stdout",
            elapsedMs: Math.round(performance.now() - start),
            text: bytes.toString(),
          }),
        ),
      );
    });
    results.push(result);
    console.log(JSON.stringify({ event: "result", ...result }));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    timeoutMsPerProbe: 15000,
    maximumOutputBytesPerStream: 8192,
    cacheMetadata,
    scope:
      "Read-only comparison: original CIM baseline, native local WMI with minimal/controlled environment, inherited cached control. Native WMI requires exactly one record and five canonical Base64 UTF-8 fields without module import or serialization cmdlets. No cache contents, environment values, policy override or product acceptance inferred.",
    probes: results,
  };
  const reportPath = path.resolve(".var/windows-native-diagnostics.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ event: "summary", ...report }));
  if (results.some(failed)) process.exitCode = 1;
} finally {
  await rm(diagnosticDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
