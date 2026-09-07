import { it, expect } from "vitest";
import { renderService, WINSW_SHA256 } from "../../packages/operations/src/services.ts";
import { NativeServiceControl } from "../../packages/operations/src/service-control.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile } from "../../packages/operations/src/common.ts";
it.each(["linux", "darwin", "win32"] as const)(
  "passes the worker configuration as an actual positional argument on %s",
  (platform) => {
    const cfg = platform === "win32" ? "C:\\Secure\\worker.json" : "/etc/ironcrew/worker.json";
    const service = renderService({ platform, role: "worker", workerConfigurationPath: cfg });
    expect(service.definition.split("worker.json").length).toBeGreaterThanOrEqual(3);
  },
);
it("rejects root, overlapping and injected native service paths", () => {
  expect(() => renderService({ platform: "darwin", role: "control", dataDirectory: "/" })).toThrow();
  expect(() => renderService({ platform: "linux", role: "control", dataDirectory: "/opt/ironcrew/data" })).toThrow();
  expect(() =>
    renderService({ platform: "linux", role: "control", publicUrl: "https://example.com/\nExecStart=bad" }),
  ).toThrow();
  expect(() =>
    renderService({ platform: "win32", role: "control", serviceDirectory: "C:\\ProgramData\\IronCrew\\wrapper" }),
  ).toThrow();
});
it("uses pinned WinSW2 side-by-side registration, protected SIDs and no unsupported refresh", () => {
  const service = renderService({ platform: "win32", role: "control" });
  expect(service.registrationScript).toContain(WINSW_SHA256);
  expect(service.registrationScript).toContain("IronCrew-services");
  expect(service.registrationScript).toContain("/elevated install");
  expect(service.registrationScript).not.toContain(" refresh");
  expect(service.registrationScript).toContain("S-1-5-19");
  expect(service.registrationScript).toContain("DirectorySecurity");
});
it("rejects an arbitrary executable masquerading as the pinned WinSW controller", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ironcrew-winsw-"));
  try {
    const executable = path.join(root, "ironcrew.exe"),
      config = path.join(root, "ironcrew.xml");
    await writeFile(executable, "not a WinSW release");
    await writeFile(config, "<service><id>ironcrew</id></service>");
    const control = new NativeServiceControl(
      {
        kind: "winsw",
        name: "ironcrew",
        executable,
        executableSha256: await hashFile(executable),
        configurationPath: config,
        configurationSha256: await hashFile(config),
      },
      root,
      root,
    );
    await expect(control.invoke("start")).rejects.toMatchObject({ code: "winsw_configuration" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("waits for an actual asynchronously exiting service process and bounds a process that stays alive", async () => {
  const { spawn } = await import("node:child_process");
  const { waitForStoppedProcess } = await import("../../packages/operations/src/service-control.ts");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),200)"], { stdio: "ignore" });
  const started = Date.now();
  await waitForStoppedProcess(child.pid!, 2000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  await expect(waitForStoppedProcess(process.pid, 15)).rejects.toMatchObject({ code: "service_effect_unknown" });
});
