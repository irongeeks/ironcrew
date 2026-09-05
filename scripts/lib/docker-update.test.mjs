import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareVersions, parseDockerUpdateArgs, updateDockerRelease } from "./docker-update.mjs";

const oldImage = `sha256:${"a".repeat(64)}`,
  newImage = `sha256:${"b".repeat(64)}`,
  digest = `sha256:${"c".repeat(64)}`,
  revision = "d".repeat(40);
const published = `ghcr.io/irongeeks/ironcrew@${digest}`;
const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docker-update-")));
  roots.push(root);
  const cwd = path.join(root, "company"),
    backupDir = path.join(root, "backups");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(cwd, "config"));
  await fs.mkdir(path.join(cwd, "workspaces"));
  for (const [name, text] of Object.entries({
    "compose.yaml": "services: {}\n",
    "compose.release.yaml": "services: {}\n",
    ".env": "SECRET=test-private-value\n",
  }))
    await fs.writeFile(path.join(cwd, name), text);
  const manifest = {
    schemaVersion: 1,
    version: "2.8.0",
    tag: "v2.8.0",
    commit: revision,
    container: { image: "ghcr.io/irongeeks/ironcrew:v2.8.0", digest },
  };
  const manifestFile = path.join(root, "release-manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const volume = "original-project_octooffice-data";
  const mounts = [
    { Type: "volume", Name: volume, Source: path.join(root, "docker-volume"), Destination: "/data", RW: true },
    { Type: "volume", Name: volume, Source: path.join(root, "docker-volume"), Destination: "/app/data", RW: true },
    { Type: "bind", Source: path.join(cwd, "config"), Destination: "/app/config", RW: false },
    { Type: "bind", Source: path.join(cwd, "workspaces"), Destination: "/workspaces", RW: true },
  ];
  const config = {
    name: "original-project",
    services: {
      ironcrew: {
        image: published,
        environment: { DB_PATH: "/data/octooffice.sqlite", SECRET: "test-private-value" },
        volumes: [
          { type: "volume", source: "octooffice-data", target: "/data" },
          { type: "volume", source: "octooffice-data", target: "/app/data" },
          { type: "bind", source: path.join(cwd, "config"), target: "/app/config", read_only: true },
          { type: "bind", source: path.join(cwd, "workspaces"), target: "/workspaces" },
        ],
      },
    },
    volumes: { "octooffice-data": { name: volume } },
  };
  let running = true,
    updated = false;
  const calls = [];
  const container = () => ({
    Id: updated ? "new-container" : "old-container",
    Image: updated ? newImage : oldImage,
    Mounts: mounts,
    State: { Running: running, Health: { Status: "healthy" } },
    Config: {
      Labels: {
        "com.docker.compose.project": "original-project",
        "com.docker.compose.service": "ironcrew",
        "com.docker.compose.project.working_dir": overrides.workingDir ?? cwd,
        "com.docker.compose.project.config_files": overrides.configFiles ?? path.join(cwd, "compose.yaml"),
      },
    },
  });
  const run = async (args, options) => {
    calls.push({ args, env: options.env, cwd: options.cwd });
    const command = args.join(" ");
    if (overrides.fail?.(args)) throw new Error("Injected Docker failure");
    if (args[0] === "context")
      return JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]);
    if (command.includes("config --format json")) return JSON.stringify(config);
    if (args[0] === "compose" && args.includes("ps"))
      return args.includes("--status") ? (running ? "new-container" : "") : updated ? "new-container" : "old-container";
    if (args[0] === "inspect") return JSON.stringify([container()]);
    if (args[0] === "exec")
      return JSON.stringify({
        ok: true,
        version: updated ? (overrides.healthVersion ?? "2.8.0") : (overrides.currentVersion ?? "2.7.0"),
      });
    if (args[0] === "ps") return overrides.otherWriter ? "other-container" : running ? "old-container" : "";
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify([
        {
          Id: newImage,
          RepoDigests: [published],
          Config: {
            Labels: {
              "org.opencontainers.image.version": "2.8.0",
              "org.opencontainers.image.revision": overrides.imageRevision ?? revision,
            },
          },
        },
      ]);
    if (options.outputFile) await fs.writeFile(options.outputFile, "complete-archive", { mode: 0o600, flag: "wx" });
    if (args[0] === "compose" && args.includes("stop")) running = false;
    if (args[0] === "compose" && args.includes("up")) {
      running = true;
      updated = true;
      if (overrides.failAfterStart) throw new Error("Health timeout");
    }
    return "";
  };
  const options = parseDockerUpdateArgs(["--to", "v2.8.0", "--backup-dir", backupDir, "--manifest", manifestFile]);
  return {
    root,
    cwd,
    backupDir,
    manifestFile,
    manifest,
    config,
    mounts,
    calls,
    run,
    options,
    get running() {
      return running;
    },
  };
}
const invoke = (f, options = {}) =>
  updateDockerRelease({ ...f.options, ...options }, { cwd: f.cwd, env: {}, run: f.run });
const record = async (f) => {
  const dirs = await fs.readdir(f.backupDir);
  return JSON.parse(await fs.readFile(path.join(f.backupDir, dirs[0], "recovery.json"), "utf8"));
};

describe("explicit Docker release update", () => {
  it("requires stable versions and explicit private backup destination; compares installed prereleases correctly", () => {
    for (const target of ["latest", "main", "v2.8.0-rc.1", "other/image:2.8.0"])
      expect(() => parseDockerUpdateArgs(["--to", target, "--backup-dir", "/backup"])).toThrow();
    expect(() => parseDockerUpdateArgs(["--to", "v2.8.0"])).toThrow();
    expect(compareVersions("2.8.0", "2.8.0-rc.10")).toBe(1);
    expect(compareVersions("2.8.0-rc.2", "2.8.0-rc.10")).toBe(-1);
  });
  it("check reads the existing project and manifest without pulling, stopping or writing", async () => {
    const f = await fixture();
    const result = await invoke(f, { dryRun: true });
    expect(result).toMatchObject({ verified: false, project: "original-project", image: published });
    expect(f.calls.some((c) => c.args[0] === "pull" || c.args.includes("stop") || c.args.includes("up"))).toBe(false);
    await expect(fs.stat(f.backupDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain("test-private-value");
  });
  it("accepts canonical aliases for the same existing Compose files and rejects extra overrides", async () => {
    const labels = {};
    const f = await fixture(labels);
    const alias = path.join(f.root, "company-alias");
    await fs.symlink(f.cwd, alias, "dir");
    labels.workingDir = alias;
    labels.configFiles = path.join(alias, "compose.yaml");
    const result = await updateDockerRelease({ ...f.options, dryRun: true }, { cwd: alias, env: {}, run: f.run });
    expect(result.cwd).toBe(f.cwd);
    const extra = path.join(f.cwd, "extra.yaml");
    await fs.writeFile(extra, "services: {}\n");
    labels.configFiles += `,${path.join(alias, "extra.yaml")}`;
    await expect(invoke(f, { dryRun: true })).rejects.toThrow("additional Compose overrides");
    expect(f.calls.some((call) => call.args.includes("stop") || call.args[0] === "pull")).toBe(false);
  });
  it.each(["EACCES", "EPERM"])("backs up daemon-owned named volumes despite host %s", async (code) => {
    const f = await fixture();
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (directory, ...args) => {
      if (directory === f.mounts[0].Source) throw Object.assign(new Error("Daemon storage inaccessible"), { code });
      return realpath(directory, ...args);
    });
    const result = await invoke(f);
    expect(result.verified).toBe(true);
    const archives = f.calls.filter((call) => call.args[0] === "run");
    expect(
      archives.some((call) => call.args.includes(`type=volume,src=${f.mounts[0].Name},dst=/source,readonly`)),
    ).toBe(true);
  });
  it.each(["bind", "backup"])("still rejects inaccessible %s paths before downtime", async (kind) => {
    const f = await fixture();
    const denied = kind === "bind" ? f.mounts[2].Source : f.backupDir;
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (directory, ...args) => {
      if (directory === denied) throw Object.assign(new Error("Host path inaccessible"), { code: "EACCES" });
      return realpath(directory, ...args);
    });
    await expect(invoke(f)).rejects.toMatchObject({ code: "EACCES" });
    expect(f.calls.some((call) => call.args.includes("stop") || call.args[0] === "pull")).toBe(false);
  });
  it("pins the published digest, pulls before stop, backs up all stopped mounts and keeps project and legacy volume", async () => {
    const f = await fixture();
    const result = await invoke(f);
    expect(result.verified).toBe(true);
    const pull = f.calls.findIndex((c) => c.args[0] === "pull"),
      stop = f.calls.findIndex((c) => c.args.includes("stop")),
      backup = f.calls.findIndex((c) => c.args[0] === "run"),
      up = f.calls.findIndex((c) => c.args.includes("up"));
    expect(pull).toBeLessThan(stop);
    expect(stop).toBeLessThan(backup);
    expect(backup).toBeLessThan(up);
    expect(f.calls.filter((c) => c.args[0] === "run")).toHaveLength(3); // Same volume at two paths is archived exactly once.
    for (const call of f.calls) {
      expect(call.cwd).toBe(f.cwd);
      expect(call.env.IRONCREW_RELEASE_IMAGE).toBe(published);
      expect(call.args).not.toContain("down");
      expect(call.args).not.toContain("--build");
      expect(call.args).not.toContain("--project-name");
    }
    expect(f.calls[up].args).toEqual(expect.arrayContaining(["--no-build", "--pull", "never", "--wait"]));
    const recovery = await record(f);
    expect(recovery.status).toBe("verified");
    expect(recovery.oldImage).toBe(oldImage);
    expect(recovery.backups.filter((b) => b.kind === "mount")).toHaveLength(3);
    expect(recovery.backups.every((b) => b.sha256.length === 64)).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, ".env"), "utf8")).toBe("SECRET=test-private-value\n");
    expect(await fs.readFile(path.join(f.cwd, "release-image.env"), "utf8")).toContain(published);
    for (const file of recovery.backups) expect((await fs.stat(file.file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.backupDirectory)).mode & 0o777).toBe(0o700);
  });
  it.each([
    { imageRevision: "e".repeat(40) },
    { fail: (args) => args[0] === "pull" },
    { currentVersion: "2.9.0" },
    { otherWriter: true },
  ])(
    "fails before stop for invalid release, failed pull, downgrade or another volume writer (%j)",
    async (overrides) => {
      const f = await fixture(overrides);
      await expect(invoke(f)).rejects.toThrow();
      expect(f.running).toBe(true);
      expect(f.calls.some((c) => c.args.includes("stop"))).toBe(false);
    },
  );
  it("rejects changed mounts and alias backup destinations before any pull or stop", async () => {
    const f = await fixture();
    f.config.services.ironcrew.volumes[0].source = "new-empty-data";
    await expect(invoke(f)).rejects.toThrow("mounts differ");
    f.config.services.ironcrew.volumes[0].source = "octooffice-data";
    const alias = path.join(f.root, "backup-alias");
    await fs.symlink(path.join(f.cwd, "config"), alias, "dir");
    await expect(invoke(f, { backupDir: path.join(alias, "nested-backup") })).rejects.toThrow(
      "outside every application mount",
    );
    expect(f.calls.some((c) => c.args[0] === "pull" || c.args.includes("stop"))).toBe(false);
  });
  it.each([{ fail: (args) => args[0] === "run" }, { failAfterStart: true }, { healthVersion: "2.7.0" }])(
    "leaves service stopped and writes exact manual recovery state after backup/up/health failure (%j)",
    async (overrides) => {
      const f = await fixture(overrides);
      await expect(invoke(f)).rejects.toThrow("Service remains stopped");
      expect(f.running).toBe(false);
      const recovery = await record(f);
      expect(recovery).toMatchObject({ status: "failed", serviceStopped: true, oldImage });
      expect(recovery.backups.some((b) => b.kind === "old-image")).toBe(true);
      expect(f.calls.filter((c) => c.args.includes("up"))).toHaveLength(overrides.fail ? 0 : 1);
      expect(f.calls.some((c) => c.args.includes("load") || c.args.includes("-xpf"))).toBe(false);
    },
  );
  it("reports an unverified stop explicitly rather than promising safe downtime", async () => {
    const f = await fixture({ failAfterStart: true, fail: (args) => args.includes("stop") });
    await expect(invoke(f)).rejects.toThrow("STOP COULD NOT BE VERIFIED");
    expect((await record(f)).serviceStopped).toBe(false);
  });
});
