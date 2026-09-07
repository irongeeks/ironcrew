import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { OperationError } from "./common.ts";
export interface HostPlatform {
  platform: string;
  arch: string;
  version: string;
  distribution?: string;
  productType?: number;
  sku?: number;
  build?: number;
  caption?: string;
}
/** Exact deployment matrix; distro derivatives, Home and future major versions are not implicit approvals. */
export function assertSupportedHost(host: HostPlatform): HostPlatform {
  const { platform, arch, version } = host;
  let supported = false;
  if (platform === "linux" && ["x64", "arm64"].includes(arch))
    supported =
      (host.distribution === "debian" && version === "13") || (host.distribution === "ubuntu" && version === "24.04");
  if (platform === "darwin" && /^\d+(?:\.\d+){0,2}$/.test(version))
    supported =
      (version.split(".")[0] === "15" && ["x64", "arm64"].includes(arch)) ||
      (version.split(".")[0] === "26" && arch === "arm64");
  if (platform === "win32" && arch === "x64" && /^10\.0\.\d+$/.test(version)) {
    if (host.productType === 1)
      supported =
        (host.build ?? 0) >= 22000 &&
        [4, 27, 48, 49, 125, 126, 161, 162].includes(host.sku ?? -1) &&
        /^Microsoft Windows 11\b/i.test(host.caption ?? "");
    else if (host.productType === 2 || host.productType === 3)
      supported =
        (host.build === 20348 && /\bWindows Server 2022\b/i.test(host.caption ?? "")) ||
        (host.build === 26100 && /\bWindows Server 2025\b/i.test(host.caption ?? ""));
  }
  if (!supported)
    throw new OperationError(
      "os_version",
      "Betriebssystem, Edition oder Architektur liegt außerhalb der freigegebenen Installationsmatrix.",
    );
  return host;
}
export function parseOsRelease(text: string): { distribution: string; version: string } {
  if (Buffer.byteLength(text) > 65536)
    throw new OperationError("os_detection", "OS-Metadaten überschreiten das Limit.");
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(ID|VERSION_ID)=(?:"([a-zA-Z0-9._-]+)"|'([a-zA-Z0-9._-]+)'|([a-zA-Z0-9._-]+))$/.exec(line);
    if (match) {
      if (values.has(match[1]!)) throw new OperationError("os_detection", "Doppelte OS-Metadaten.");
      values.set(match[1]!, match[2] ?? match[3] ?? match[4]!);
    }
  }
  if (!values.has("ID") || !values.has("VERSION_ID"))
    throw new OperationError("os_detection", "OS-Version ist nicht zuverlässig erkennbar.");
  return { distribution: values.get("ID")!, version: values.get("VERSION_ID")! };
}
export async function detectHostPlatform(): Promise<HostPlatform> {
  const platform = process.platform,
    arch = process.arch;
  const run = promisify(execFile);
  if (platform === "linux") return { platform, arch, ...parseOsRelease(await readFile("/etc/os-release", "utf8")) };
  if (platform === "darwin") {
    const { stdout } = await run("/usr/bin/sw_vers", ["-productVersion"], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10000,
      maxBuffer: 1024,
    });
    return { platform, arch, version: stdout.trim() };
  }
  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    if (!path.win32.isAbsolute(systemRoot) || /[\r\n\0]/.test(systemRoot))
      throw new OperationError("os_detection", "Windows-Systempfad ist ungültig.");
    const { stdout } = await run(
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Select-Object Version,BuildNumber,ProductType,OperatingSystemSKU,Caption | ConvertTo-Json -Compress",
      ],
      { env: { SystemRoot: systemRoot, WINDIR: systemRoot }, timeout: 15000, maxBuffer: 8192 },
    );
    const value = JSON.parse(stdout.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    return {
      platform,
      arch,
      version: String(value.Version),
      build: Number(value.BuildNumber),
      productType: Number(value.ProductType),
      sku: Number(value.OperatingSystemSKU),
      caption: String(value.Caption),
    };
  }
  throw new OperationError("platform", "Unbekannte Betriebssystemplattform.");
}
