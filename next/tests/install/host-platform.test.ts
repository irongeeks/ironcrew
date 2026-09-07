import { it, expect } from "vitest";
import {
  assertSupportedHost,
  detectHostPlatform,
  parseOsRelease,
  parseWindowsOsMetadata,
  type HostPlatform,
} from "../../packages/operations/src/host-platform.ts";
import { renderService } from "../../packages/operations/src/services.ts";
import { registrationPreflight } from "../../packages/operations/src/install-preflight.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const windows = {
  platform: "win32",
  arch: "x64",
  version: "10.0.26100",
  build: 26100,
  productType: 1,
  sku: 48,
  caption: "Microsoft Windows 11 Pro",
};
const encodeWindowsFields = (fields: string[]) =>
  fields.map((value) => Buffer.from(value).toString("base64")).join("\r\n") + "\r\n";
const windowsFields = ["10.0.26100", "26100", "3", "8", "Microsoft Windows Server 2025 Datacenter"];
it("decodes the five native WMI fields with the same types and OS allowance as the CIM control", () => {
  const decoded = parseWindowsOsMetadata(encodeWindowsFields(windowsFields));
  expect(decoded).toEqual({ version: "10.0.26100", build: 26100, productType: 3, sku: 8, caption: windowsFields[4] });
  expect(assertSupportedHost({ platform: "win32", arch: "x64", ...decoded }).sku).toBe(8);
  const home = parseWindowsOsMetadata(
    encodeWindowsFields(["10.0.26100", "26100", "1", "101", "Microsoft Windows 11 Home"]),
  );
  expect(() => assertSupportedHost({ platform: "win32", arch: "x64", ...home })).toThrow();
  expect(
    parseWindowsOsMetadata(encodeWindowsFields([...windowsFields.slice(0, 4), "Windows Édition 日本語"])).caption,
  ).toBe("Windows Édition 日本語");
});
it.each([
  ["missing field", encodeWindowsFields(windowsFields.slice(0, 4))],
  ["extra record", encodeWindowsFields([...windowsFields, ...windowsFields])],
  ["extra blank line", encodeWindowsFields(windowsFields) + "\r\n"],
  ["noncanonical base64", encodeWindowsFields(windowsFields).replace("MTAuMC4yNjEwMA==", "MTAuMC4yNjEwMA")],
  ["invalid UTF-8", encodeWindowsFields(windowsFields).replace("MTAuMC4yNjEwMA==", "/w==")],
  ["fractional SKU", encodeWindowsFields([...windowsFields.slice(0, 3), "8.5", windowsFields[4]!])],
  ["negative build", encodeWindowsFields([windowsFields[0]!, "-26100", ...windowsFields.slice(2)])],
  ["unsafe integer", encodeWindowsFields([windowsFields[0]!, "9007199254740992", ...windowsFields.slice(2)])],
  ["caption control character", encodeWindowsFields([...windowsFields.slice(0, 4), "Windows\nServer"])],
  ["oversized output", "A".repeat(8193)],
])("rejects ambiguous or corrupt native Windows metadata: %s", (_, output) => {
  expect(() => parseWindowsOsMetadata(output)).toThrow(expect.objectContaining({ code: "os_detection" }));
});
it.each<HostPlatform>([
  { platform: "linux", arch: "x64", distribution: "debian", version: "13" },
  { platform: "linux", arch: "arm64", distribution: "ubuntu", version: "24.04" },
  { platform: "darwin", arch: "x64", version: "15.7.1" },
  { platform: "darwin", arch: "arm64", version: "26.0" },
  windows,
  { ...windows, sku: 4, caption: "Microsoft Windows 11 Enterprise" },
  {
    ...windows,
    productType: 3,
    build: 20348,
    version: "10.0.20348",
    caption: "Microsoft Windows Server 2022 Standard",
  },
  { ...windows, productType: 2, caption: "Microsoft Windows Server 2025 Datacenter" },
])("accepts the documented OS/edition combination %j", (h) => expect(assertSupportedHost(h)).toBe(h));
it.each<HostPlatform>([
  { platform: "linux", arch: "x64", distribution: "debian", version: "12" },
  { platform: "linux", arch: "arm64", distribution: "ubuntu", version: "26.04" },
  { platform: "linux", arch: "x64", distribution: "linuxmint", version: "24.04" },
  { platform: "darwin", arch: "arm64", version: "14.7" },
  { platform: "darwin", arch: "x64", version: "26.0" },
  { ...windows, sku: 101, caption: "Microsoft Windows 11 Home" },
  { ...windows, version: "10.0.19045", build: 19045, caption: "Microsoft Windows 10 Pro" },
  { ...windows, productType: 3, build: 17763, caption: "Microsoft Windows Server 2019 Standard" },
  { ...windows, arch: "arm64" },
  { ...windows, caption: "Microsoft Windows 12 Pro" },
])("rejects unsupported OS versions/editions before installation %j", (h) =>
  expect(() => assertSupportedHost(h)).toThrow(),
);
it("parses distro identity without executing os-release content or accepting duplicate identifiers", () => {
  expect(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n')).toEqual({
    distribution: "ubuntu",
    version: "24.04",
  });
  expect(() => parseOsRelease('ID=ubuntu\nVERSION_ID="$(touch /tmp/no)"')).toThrow();
  expect(() => parseOsRelease("ID=ubuntu\nID=debian\nVERSION_ID=13")).toThrow();
});
it.each(["linux", "darwin", "win32"] as const)(
  "executes actual host preflight before the first native mutation on %s",
  (platform) => {
    const script = renderService({ platform, role: "control" }).registrationScript;
    const check = script.indexOf("install-preflight.js");
    expect(check).toBeGreaterThan(0);
    for (const marker of platform === "linux"
      ? ["groupadd", "useradd", "systemctl enable"]
      : platform === "darwin"
        ? ["dscl . -create", "launchctl bootout"]
        : ["New-Item", "Set-Acl", "/elevated install"]) {
      if (script.includes(marker)) expect(check).toBeLessThan(script.indexOf(marker));
    }
  },
);
it("runs real host detection and the native registration preflight without changing services", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ic-host-preflight-")));
  try {
    const host = await detectHostPlatform();
    expect(host.platform).toBe(process.platform);
    expect(host.version).toMatch(/^\d+/);
    if (host.platform === "win32") {
      expect(host.build).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(host.productType);
      expect(Number.isSafeInteger(host.sku)).toBe(true);
      expect(host.caption).toMatch(/^Microsoft Windows /);
    }
    // Current test hosts themselves must be in the shipping matrix; unsupported hosts fail this acceptance gate.
    expect(assertSupportedHost(host)).toBe(host);
    const result = await registrationPreflight(process.platform, root, path.join(root, "new-data"));
    expect(result.osVersion).toBe(host.version);
    await expect(
      registrationPreflight(process.platform === "linux" ? "darwin" : "linux", root, root),
    ).rejects.toMatchObject({ code: "platform" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
