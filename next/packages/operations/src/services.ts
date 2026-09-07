import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { OperationError } from "./common.ts";
export const WINSW_VERSION = "2.12.0";
export const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";
export const WINSW_SOURCE = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
export const PLATFORM_MATRIX = [
  { platform: "linux", arch: "x64", systems: ["Debian 13", "Ubuntu 24.04 LTS"], service: "systemd" },
  { platform: "linux", arch: "arm64", systems: ["Debian 13", "Ubuntu 24.04 LTS"], service: "systemd" },
  { platform: "darwin", arch: "x64", systems: ["macOS 15"], service: "launchd" },
  { platform: "darwin", arch: "arm64", systems: ["macOS 15", "macOS 26"], service: "launchd" },
  {
    platform: "win32",
    arch: "x64",
    systems: ["Windows 11 Pro/Enterprise", "Windows Server 2022", "Windows Server 2025"],
    service: "WinSW 2.12.0",
  },
] as const;
export interface ServiceOptions {
  platform: "linux" | "darwin" | "win32";
  role: "control" | "worker";
  programDirectory?: string;
  dataDirectory?: string;
  user?: string;
  port?: number;
  previewPort?: number;
  publicUrl?: string;
  workerConfigurationPath?: string;
  serviceName?: string;
  serviceDirectory?: string;
  launchdDomain?: string;
}
export interface ServiceBundle {
  name: string;
  definition: string;
  registrationScript: string;
  scriptName: string;
  programDirectory: string;
  dataDirectory: string;
}
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const shell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
const systemd = (value: string, expandEnvironment = false) =>
  '"' +
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (expandEnvironment ? "$$" : "$")) +
  '"';
export function renderService(options: ServiceOptions): ServiceBundle {
  const platform = options.platform;
  const name = options.serviceName ?? (options.role === "worker" ? "ironcrew-worker" : "ironcrew");
  if (!/^ironcrew(?:-[a-z0-9-]{1,70})?$/.test(name))
    throw new OperationError("service_name", "Ungültiger eigener Dienstname.");
  const domain = options.launchdDomain ?? "system";
  if (!/^(system|gui\/[0-9]+|user\/[0-9]+)$/.test(domain))
    throw new OperationError("service_domain", "Ungültige launchd-Domain.");
  const programDirectory =
    options.programDirectory ??
    (platform === "win32"
      ? "C:\\Program Files\\IronCrew"
      : platform === "darwin"
        ? "/Library/Application Support/IronCrew/app"
        : "/opt/ironcrew");
  const dataDirectory =
    options.dataDirectory ??
    (platform === "win32"
      ? "C:\\ProgramData\\IronCrew"
      : platform === "darwin"
        ? "/Library/Application Support/IronCrew/data"
        : "/var/lib/ironcrew");
  const paths = platform === "win32" ? path.win32 : path.posix;
  for (const value of [programDirectory, dataDirectory])
    if (
      !paths.isAbsolute(value) ||
      value === paths.parse(value).root ||
      (platform === "win32" && value.includes('"')) ||
      [...value].some((char) => char.charCodeAt(0) < 32)
    )
      throw new OperationError(
        "service_path",
        "Dienstpfade müssen absolut sein und dürfen keine Steuerzeichen enthalten.",
      );
  if (
    [programDirectory, dataDirectory].some((a, i) => {
      const b = [dataDirectory, programDirectory][i]!;
      return a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + paths.sep);
    })
  )
    throw new OperationError("service_directory_overlap", "Programm und Daten müssen getrennt liegen.");
  const user = options.user ?? "ironcrew";
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(user) || user === "root")
    throw new OperationError("service_user", "Ein dediziertes Dienstkonto ist erforderlich.");
  const port = options.port ?? 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new OperationError("service_port", "Ungültiger Dienstport.");
  const previewPort = options.previewPort ?? 8792;
  if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535 || previewPort === port)
    throw new OperationError("service_port", "Vorschau benötigt einen gültigen separaten Port.");
  if (
    options.publicUrl &&
    (!options.publicUrl.startsWith("https://") ||
      /[\r\n\0]/.test(options.publicUrl) ||
      new URL(options.publicUrl).username ||
      new URL(options.publicUrl).password)
  )
    throw new OperationError("service_tls", "Eine öffentliche Dienst-URL benötigt HTTPS.");
  const node = paths.join(programDirectory, "runtime", platform === "win32" ? "node.exe" : "node");
  const entry = paths.join(
    programDirectory,
    "dist",
    "apps",
    options.role === "worker" ? "worker" : "control",
    "main.js",
  );
  const workerConfig = options.workerConfigurationPath ?? paths.join(dataDirectory, "worker-configuration.json");
  if (!paths.isAbsolute(workerConfig) || /[\r\n\0]/.test(workerConfig))
    throw new OperationError("service_path", "Worker-Konfiguration muss ein absoluter Pfad sein.");
  const preflight = paths.join(programDirectory, "dist", "packages", "operations", "src", "install-preflight.js");
  const safePaths = [
    preflight,
    programDirectory,
    dataDirectory,
    node,
    entry,
    ...(options.role === "worker" ? [workerConfig] : []),
  ];
  const pathPreflight = `PATH=/usr/bin:/bin:/usr/sbin:/sbin\nexport PATH\nassert_path() { p="$1"; while [ "$p" != / ] && [ -n "$p" ]; do [ ! -L "$p" ] || { echo 'Symlink path rejected' >&2; exit 1; }; p=$(dirname "$p"); done; }\n${safePaths.map((p) => `assert_path ${shell(p)}`).join("\n")}\n`;
  const hostPreflight = `${shell(node)} ${shell(preflight)} ${shell(platform)} ${shell(programDirectory)} ${shell(dataDirectory)}\n`;
  const argv = [node, entry, ...(options.role === "worker" ? [workerConfig] : [])];
  const environment: Record<string, string> = {
    NODE_ENV: "production",
    IRONCREW_DATA_DIR: dataDirectory,
    IRONCREW_HOST: "127.0.0.1",
    IRONCREW_PORT: String(port),
    IRONCREW_PREVIEW_PORT: String(previewPort),
    ...(options.publicUrl ? { IRONCREW_PUBLIC_URL: options.publicUrl } : {}),
    ...(options.role === "worker" ? { IRONCREW_WORKER_CONFIG: workerConfig } : {}),
  };
  if (platform === "linux") {
    const definition = `[Unit]\nDescription=IronCrew ${options.role}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=${user}\nGroup=${user}\nWorkingDirectory=${systemd(programDirectory)}\nExecStart=${argv.map((a) => systemd(a, true)).join(" ")}\n${Object.entries(
      environment,
    )
      .map(([key, value]) => `Environment=${systemd(`${key}=${value}`)}`)
      .join(
        "\n",
      )}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nReadWritePaths=${systemd(dataDirectory)}\n\n[Install]\nWantedBy=multi-user.target\n`;
    const registrationScript = `#!/bin/sh\nset -eu\n${pathPreflight}${hostPreflight}[ "$(id -u)" -eq 0 ] || { echo 'Administrator privileges required' >&2; exit 1; }\ngetent group ${shell(user)} >/dev/null || groupadd --system ${shell(user)}\nid ${shell(user)} >/dev/null 2>&1 || useradd --system --gid ${shell(user)} --home-dir ${shell(dataDirectory)} --shell /usr/sbin/nologin ${shell(user)}\ninstall -d -m 0700 -o ${shell(user)} -g ${shell(user)} ${shell(dataDirectory)}\ntest -x ${shell(node)}\ntest -f ${shell(entry)}\ninstall -m 0644 ${shell(name + ".service")} ${shell("/etc/systemd/system/" + name + ".service")}\nsystemctl daemon-reload\nsystemctl enable --now ${shell(name + ".service")}\nsystemctl is-active --quiet ${shell(name + ".service")}\n`;
    return {
      name: name + ".service",
      definition,
      registrationScript,
      scriptName: "register-service.sh",
      programDirectory,
      dataDirectory,
    };
  }
  if (platform === "darwin") {
    const label = `eu.irongeeks.${name}`;
    const definition = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string>${domain === "system" ? `<key>UserName</key><string>${xml(user)}</string><key>GroupName</key><string>${xml(user)}</string>` : ""}<key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(programDirectory)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
      environment,
    )
      .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
      .join(
        "",
      )}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>45</integer><key>StandardOutPath</key><string>${xml(paths.join(dataDirectory, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(paths.join(dataDirectory, "service-error.log"))}</string><key>Umask</key><integer>63</integer></dict></plist>\n`;
    const plist =
      domain === "system" ? `/Library/LaunchDaemons/${label}.plist` : paths.join(dataDirectory, `${label}.plist`);
    const systemRegistration = `#!/bin/sh\nset -eu\n${pathPreflight}${hostPreflight}[ "$(id -u)" -eq 0 ] || { echo 'Administrator privileges required' >&2; exit 1; }\nif ! dscl . -read /Users/${user} >/dev/null 2>&1; then\n  account_id=$(dscl . -list /Users UniqueID | awk 'BEGIN { max=500 } $2>max { max=$2 } END { print max+1 }')\n  group_id=$(dscl . -list /Groups PrimaryGroupID | awk 'BEGIN { max=500 } $2>max { max=$2 } END { print max+1 }')\n  dscl . -create /Groups/${user}\n  dscl . -create /Groups/${user} PrimaryGroupID "$group_id"\n  dscl . -create /Users/${user}\n  dscl . -create /Users/${user} UniqueID "$account_id"\n  dscl . -create /Users/${user} PrimaryGroupID "$group_id"\n  dscl . -create /Users/${user} UserShell /usr/bin/false\n  dscl . -create /Users/${user} NFSHomeDirectory ${shell(dataDirectory)}\n  dscl . -create /Users/${user} IsHidden 1\nfi\ninstall -d -m 0700 -o ${shell(user)} -g ${shell(user)} ${shell(dataDirectory)}\ntest -x ${shell(node)}\ntest -f ${shell(entry)}\nplutil -lint ${shell(label + ".plist")}\nif [ -e ${shell(plist)} ]; then test ! -L ${shell(plist)}; cmp -s ${shell(label + ".plist")} ${shell(plist)} || { echo 'Existing service configuration differs; explicit administrative reconfiguration required' >&2; exit 1; }; fi\nif launchctl print system/${label} >/dev/null 2>&1; then test -f ${shell(plist)} && test ! -L ${shell(plist)} && cmp -s ${shell(label + ".plist")} ${shell(plist)} || { echo 'Existing launchd label is not this installation' >&2; exit 1; }; fi\nlaunchctl bootout system/${label} >/dev/null 2>&1 || true\ninstall -m 0644 ${shell(label + ".plist")} ${shell(plist)}\nchown root:wheel ${shell(plist)}\nlaunchctl bootstrap system ${shell(plist)}\nlaunchctl print system/${label}\n`;
    const userRegistration = `#!/bin/sh
set -eu
${pathPreflight}${hostPreflight}[ "$(id -u)" -eq ${domain.split("/")[1] ?? "0"} ] || { echo 'Wrong launchd user domain' >&2; exit 1; }
mkdir -p ${shell(dataDirectory)}
chmod 0700 ${shell(dataDirectory)}
test -x ${shell(node)}
test -f ${shell(entry)}
plutil -lint ${shell(label + ".plist")}
if launchctl print ${shell(domain + "/" + label)} >/dev/null 2>&1; then
  test -f ${shell(plist)} && test ! -L ${shell(plist)} && cmp -s ${shell(label + ".plist")} ${shell(plist)} || { echo 'Existing launchd label is not this fixture' >&2; exit 1; }
  exit 0
fi
install -m 0600 ${shell(label + ".plist")} ${shell(plist)}
trap 'launchctl bootout ${domain}/${label} >/dev/null 2>&1 || true' EXIT HUP INT TERM
launchctl bootstrap ${shell(domain)} ${shell(plist)}
launchctl print ${shell(domain + "/" + label)}
trap - EXIT HUP INT TERM
`;
    const registrationScript = domain === "system" ? systemRegistration : userRegistration;
    return {
      name: label + ".plist",
      definition,
      registrationScript,
      scriptName: "register-service.sh",
      programDirectory,
      dataDirectory,
    };
  }
  const executable = paths.join(programDirectory, "winsw", "WinSW-x64.exe");
  const definition = `<service><id>${name}</id><name>IronCrew ${options.role}</name><description>IronCrew native ${options.role}</description><executable>${xml(node)}</executable><arguments>${xml(
    argv
      .slice(1)
      .map((a) => '"' + a + '"')
      .join(" "),
  )}</arguments><workingdirectory>${xml(programDirectory)}</workingdirectory>${Object.entries(environment)
    .map(([key, value]) => `<env name="${xml(key)}" value="${xml(value)}"/>`)
    .join(
      "",
    )}<serviceaccount><username>NT AUTHORITY\\LocalService</username></serviceaccount><startmode>Automatic</startmode><onfailure action="restart" delay="10 sec"/><stoptimeout>45 sec</stoptimeout><logpath>${xml(dataDirectory)}</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log></service>\n`;
  const serviceDirectory = options.serviceDirectory ?? paths.join(paths.dirname(programDirectory), "IronCrew-services");
  if (
    !paths.isAbsolute(serviceDirectory) ||
    serviceDirectory === paths.parse(serviceDirectory).root ||
    [programDirectory, dataDirectory].some(
      (p) =>
        serviceDirectory.toLowerCase() === p.toLowerCase() ||
        serviceDirectory.toLowerCase().startsWith(p.toLowerCase() + paths.sep) ||
        p.toLowerCase().startsWith(serviceDirectory.toLowerCase() + paths.sep),
    ) ||
    /[\r\n\0]/.test(serviceDirectory)
  )
    throw new OperationError(
      "service_directory",
      "Administrativer Dienstwrapper muss getrennt von Programm und Daten liegen.",
    );
  const wrapper = paths.join(serviceDirectory, name + ".exe"),
    config = paths.join(serviceDirectory, name + ".xml");
  const registrationScript = `$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges required' }
function Assert-RegularPath([string]$p) { $p = [IO.Path]::GetFullPath($p); while ($p) { if (Test-Path -LiteralPath $p) { if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path rejected' } }; $parent = Split-Path -Parent $p; if ($parent -eq $p) { break }; $p = $parent } }
foreach ($p in @(${[node, entry, preflight, executable, programDirectory, dataDirectory, serviceDirectory].map(ps).join(",")})) { Assert-RegularPath $p }
if (-not (Test-Path -LiteralPath ${ps(node)})) { throw 'Verified private Node runtime is missing' }
if (-not (Test-Path -LiteralPath ${ps(entry)})) { throw 'Built service entrypoint is missing' }
& ${ps(node)} ${ps(preflight)} ${ps(platform)} ${ps(programDirectory)} ${ps(dataDirectory)}
if ($LASTEXITCODE -ne 0) { throw 'Native OS/runtime/filesystem preflight failed' }
if (-not (Test-Path -LiteralPath ${ps(executable)})) { throw 'Verified WinSW ${WINSW_VERSION} is missing from release' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath ${ps(executable)}).Hash -ne ${ps(WINSW_SHA256)}) { throw 'WinSW checksum mismatch' }
$definition = Join-Path $PSScriptRoot ${ps(name + ".xml")}
Assert-RegularPath $definition
$existing = Get-Service -Name ${ps(name)} -ErrorAction SilentlyContinue
if ($existing) {
  $registered = Get-CimInstance Win32_Service -Filter ${ps("Name='" + name + "'")}
  if (-not $registered -or $registered.PathName.Trim() -ne ${ps('"' + wrapper + '"')} -or $registered.StartName -ne 'NT AUTHORITY\\LocalService') { throw 'Existing SCM identity differs from this installation' }
  Assert-RegularPath ${ps(wrapper)}
  Assert-RegularPath ${ps(config)}
  if (-not (Test-Path -LiteralPath ${ps(wrapper)}) -or -not (Test-Path -LiteralPath ${ps(config)})) { throw 'Existing service is not this installation' }
  if ((Get-FileHash -LiteralPath ${ps(config)}).Hash -ne (Get-FileHash -LiteralPath $definition).Hash) { throw 'Existing service configuration differs; explicit reconfiguration required' }
  if ((Get-FileHash -LiteralPath ${ps(wrapper)}).Hash -ne ${ps(WINSW_SHA256)}) { throw 'Existing service wrapper changed' }
} else {
  New-Item -ItemType Directory -Force -Path ${ps(dataDirectory)},${ps(serviceDirectory)} | Out-Null
  & icacls ${ps(dataDirectory)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Data ACL configuration failed' }
  & icacls ${ps(serviceDirectory)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Service ACL configuration failed' }
  foreach ($item in @(@(${ps(dataDirectory)},'Modify'),@(${ps(serviceDirectory)},'ReadAndExecute'))) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($sid in @('S-1-5-18','S-1-5-32-544','S-1-5-19')) {
      $rights = if ($sid -eq 'S-1-5-19') { $item[1] } else { 'FullControl' }
      $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item[0] -AclObject $acl
  }
  & icacls ${ps(programDirectory)} /grant:r '*S-1-5-19:(OI)(CI)RX' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Program ACL configuration failed' }
  Copy-Item -LiteralPath ${ps(executable)} -Destination ${ps(wrapper)}
  Copy-Item -LiteralPath $definition -Destination ${ps(config)}
  & ${ps(wrapper)} /elevated install
  if ($LASTEXITCODE -ne 0) { throw 'WinSW service registration failed' }
}
try {
  & ${ps(wrapper)} /elevated start
  if ($LASTEXITCODE -ne 0) { throw 'WinSW service start failed' }
  (Get-Service -Name ${ps(name)}).WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
} catch {
  if (-not $existing) { & ${ps(wrapper)} /elevated stop; & ${ps(wrapper)} /elevated uninstall }
  throw
}
`;

  return {
    name: name + ".xml",
    definition,
    registrationScript,
    scriptName: "register-service.ps1",
    programDirectory,
    dataDirectory,
  };
}
export async function writeServiceBundle(directory: string, options: ServiceOptions): Promise<ServiceBundle> {
  const bundle = renderService(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, bundle.name), bundle.definition, { mode: 0o600 });
  await writeFile(path.join(directory, bundle.scriptName), bundle.registrationScript, { mode: 0o700 });
  return bundle;
}
