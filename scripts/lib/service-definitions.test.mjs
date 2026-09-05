import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderService } from "./service-definitions.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
describe("native service definition safety", () => {
  it("renders separate service identities and keeps runner credentials outside control-plane grants", () => {
    const control = renderService({ platform: "linux", role: "control" }).content;
    const runner = renderService({ platform: "linux", role: "runner" }).content;
    expect(control).toContain("User=ironcrew\n");
    expect(runner).toContain("User=ironcrew-runner\n");
    expect(control).not.toContain("/var/lib/ironcrew-runner");
    expect(runner).not.toContain('"/opt/ironcrew/data"');
    expect(control).toContain("ProtectHome=true");
    expect(runner).toContain("UMask=0027");
  });
  it("escapes launchd XML and preserves paths as distinct argument strings", () => {
    const result = renderService({
      platform: "darwin",
      prefix: "/Applications/Iron & Crew <private>",
      node: "/opt/node bin/node",
    });
    expect(result.content).toContain("Iron &amp; Crew &lt;private&gt;");
    expect(result.content).toContain("<string>/opt/node bin/node</string>");
    expect(result.content).not.toContain("/bin/sh");
  });
  it("escapes systemd specifiers and environment substitutions without shell interpolation", () => {
    const text = renderService({ platform: "linux", prefix: '/opt/crew %i $USER "quoted"' }).content;
    expect(text).toContain('%%i $$USER \\"quoted\\"');
    expect(text).not.toContain("/bin/sh");
  });
  it.each([
    { prefix: "/opt/crew\nUser=root" },
    { node: "node" },
    { user: "root" },
    { group: "root" },
    { role: "shell" },
  ])("rejects unsafe configuration %j", (options) => {
    expect(() => renderService({ ...options, platform: "linux" })).toThrow();
  });
  it("render mode writes reviewable definitions without installing services", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "crew-service-"));
    try {
      for (const role of ["control", "runner"]) {
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, "scripts/deploy-service.mjs"),
            "render",
            "--platform",
            "darwin",
            "--role",
            role,
            "--output",
            directory,
          ],
          { encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
      }
      expect(readdirSync(directory).sort()).toEqual([
        "eu.irongeeks.ironcrew-runner.plist",
        "eu.irongeeks.ironcrew.plist",
      ]);
      if (process.platform === "darwin")
        for (const name of readdirSync(directory)) {
          const validation = spawnSync("plutil", ["-lint", path.join(directory, name)], { encoding: "utf8" });
          expect(validation.status, validation.stdout + validation.stderr).toBe(0);
        }
      expect(readFileSync(path.join(directory, "eu.irongeeks.ironcrew.plist"), "utf8")).toContain(
        "<key>Umask</key><integer>23</integer>",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("refuses exposed environment files and placeholder credentials before service startup", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "crew-service-env-"));
    try {
      const file = path.join(directory, "service.env");
      writeFileSync(file, "OAUTH_ENCRYPTION_SECRET=__CHANGE_ME__\n", { mode: 0o644 });
      const start = () =>
        spawnSync(process.execPath, [path.join(root, "scripts/service-start.mjs"), file, "control"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
        });
      const exposed = start();
      expect(exposed.status).not.toBe(0);
      expect(exposed.stderr).toContain("mode 0600");
      chmodSync(file, 0o600);
      const placeholder = start();
      expect(placeholder.status).not.toBe(0);
      expect(placeholder.stderr).toContain("unique value");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
