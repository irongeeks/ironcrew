import process from "node:process";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateRelease, execute, cleanEnvironment, assertStopped, publishedCommit } from "./release-update.mjs";
let directory, source, repo, oldCommit, commit, backupRoot, db, options, calls, failStep;
const git = async (cwd, ...args) => {
  const result = await execute("git", args, { cwd });
  if (result.status !== 0) throw new Error("Fixture git operation failed: " + args[0]);
  return result.stdout.trim();
};
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "crew update space-")));
  source = path.join(directory, "source");
  repo = path.join(directory, "installed");
  backupRoot = path.join(directory, "backups");
  db = path.join(directory, "company.sqlite");
  await fs.mkdir(source);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "config", "user.name", "Release Fixture");
  await fs.mkdir(path.join(source, "scripts"));
  await fs.writeFile(
    path.join(source, "scripts/ironcrew-backup.mjs"),
    `import fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2);if(a.includes('--out'))fs.writeFileSync(path.join(a[a.indexOf('--out')+1],'backup.tar.gz'),'fixture archive');console.log('PRIVATE_BACKUP_OUTPUT');`,
  );
  await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\ndist/\n.env\ndata/\nvault/\nconfig/private/\n");
  const pkg = (version) => JSON.stringify({ name: "ironcrew", version, packageManager: "pnpm@10.30.1" });
  await fs.writeFile(path.join(source, "package.json"), pkg("1.0.0"));
  await fs.writeFile(path.join(source, "app.txt"), "previous release");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "old");
  await git(source, "tag", "v1.0.0");
  oldCommit = await git(source, "rev-parse", "HEAD");
  await git(directory, "clone", source, repo);
  await fs.writeFile(path.join(source, "package.json"), pkg("1.1.0"));
  await fs.writeFile(path.join(source, "app.txt"), "new release");
  await git(source, "commit", "-am", "release");
  await git(source, "tag", "-a", "v1.1.0", "-m", "release");
  commit = await git(source, "rev-parse", "HEAD");
  for (const item of [
    "node_modules",
    "dist",
    "config/private",
    "data/private-assets",
    "data/crew-attachments",
    "data/vault",
    "vault",
  ])
    await fs.mkdir(path.join(repo, item), { recursive: true });
  await fs.writeFile(path.join(repo, "node_modules/prior"), "old dependencies");
  await fs.writeFile(path.join(repo, "dist/prior"), "old build");
  await fs.writeFile(path.join(repo, ".env"), "SECRET_VALUE=PRIVATE_TEST_SECRET");
  await fs.writeFile(db, "unchanged database");
  options = { repo, to: "v1.1.0", commit, db, backupDir: backupRoot, serviceManager: "manual", confirmStopped: true };
  calls = [];
  failStep = null;
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
async function run(command, args, runOptions) {
  calls.push({ command, args, options: runOptions });
  if (command === "pnpm") {
    if (args[0] === "--version") return { status: 0, stdout: "10.30.1\n", stderr: "" };
    const artifact = args[0] === "install" ? "node_modules" : "dist";
    await fs.mkdir(path.join(runOptions.cwd, artifact), { recursive: true });
    await fs.writeFile(path.join(runOptions.cwd, artifact, "current"), "new " + artifact);
    return { status: failStep === args[0] ? 1 : 0, stdout: "PRIVATE_INSTALL_OUTPUT", stderr: "PRIVATE_INSTALL_SECRET" };
  }
  if (command === process.execPath && failStep === "backup")
    return { status: 1, stdout: "PRIVATE_BACKUP_OUTPUT", stderr: "PRIVATE_BACKUP_SECRET" };
  if (command === "git" && failStep === "checkout" && args[0] === "checkout" && args.includes(commit))
    return { status: 1, stdout: "", stderr: "PRIVATE_GIT_OUTPUT" };
  return execute(command, args, runOptions);
}
describe("native explicit release update with real local Git checkouts", () => {
  it("checks an annotated stable tag without backup, install, daemon checks or checkout changes", async () => {
    const result = await updateRelease({ ...options, check: true }, { run });
    expect(result).toMatchObject({ commit, mode: "check", serviceStarted: false, databaseMigrated: false });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
    expect(calls.some((c) => c.command === "pnpm")).toBe(false);
    expect(await fs.stat(backupRoot).catch(() => null)).toBeNull();
    expect(await git(repo, "for-each-ref", "refs/ironcrew-update")).toBe("");
  });
  it("backs up before installing in isolation, then swaps only pinned code and build artifacts", async () => {
    const messages = [];
    const result = await updateRelease(options, { run, onProgress: (m) => messages.push(m) });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(commit);
    expect(await git(repo, "rev-parse", "main")).toBe(oldCommit);
    expect(await fs.readFile(path.join(repo, "app.txt"), "utf8")).toBe("new release");
    expect(await fs.readFile(path.join(repo, "node_modules/current"), "utf8")).toContain("new");
    expect(await fs.readFile(path.join(repo, ".env"), "utf8")).toBe("SECRET_VALUE=PRIVATE_TEST_SECRET");
    expect(await fs.readFile(db, "utf8")).toBe("unchanged database");
    const backupCall = calls.findIndex((c) => c.command === process.execPath);
    const installCall = calls.findIndex((c) => c.command === "pnpm" && c.args[0] === "install");
    expect(backupCall).toBeLessThan(installCall);
    expect(calls[backupCall].args).toEqual(
      expect.arrayContaining([
        path.join(repo, "data/private-assets"),
        path.join(repo, "data/crew-attachments"),
        path.join(repo, "data/vault"),
        path.join(repo, "config/private"),
        path.join(repo, ".env"),
      ]),
    );
    expect(calls[installCall].options.cwd).not.toBe(repo);
    expect(calls.some((c) => c.args.includes("pull") || c.args.includes("start"))).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("PRIVATE");
    expect((await fs.stat(result.backupDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(result.backupDirectory, "backup.tar.gz"))).mode & 0o777).toBe(0o600);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("candidate");
  });
  it.each(["backup", "install", "build", "checkout"])(
    "preserves original checkout, data and dependencies when %s fails",
    async (step) => {
      failStep = step;
      let failure;
      try {
        await updateRelease(options, { run });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeTruthy();
      expect(failure.message).not.toContain("PRIVATE");
      expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
      expect(await fs.readFile(path.join(repo, "node_modules/prior"), "utf8")).toBe("old dependencies");
      expect(await fs.readFile(path.join(repo, "dist/prior"), "utf8")).toBe("old build");
      expect(await fs.readFile(db, "utf8")).toBe("unchanged database");
      expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("candidate");
    },
  );
  it("restores code if artifact switching is blocked by an external symlink", async () => {
    await fs.rm(path.join(repo, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(directory, "external-deps"));
    await fs.writeFile(path.join(directory, "external-deps/keep"), "external");
    await fs.symlink(path.join(directory, "external-deps"), path.join(repo, "node_modules"));
    // A symlink root does not match Git's node_modules/ directory ignore; explicitly ignore the path in this fixture.
    await fs.appendFile(path.join(repo, ".git/info/exclude"), "\nnode_modules\n");
    await expect(updateRelease(options, { run })).rejects.toThrow("Symlinks");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
    expect(await fs.readFile(path.join(directory, "external-deps/keep"), "utf8")).toBe("external");
    expect(await fs.readFile(path.join(repo, "dist/prior"), "utf8")).toBe("old build");
  });
  it("restores already swapped dependencies when the subsequent build artifact switch fails", async () => {
    await fs.rm(path.join(repo, "dist"), { recursive: true });
    await fs.mkdir(path.join(directory, "external-build"));
    await fs.writeFile(path.join(directory, "external-build/keep"), "untouched");
    await fs.symlink(path.join(directory, "external-build"), path.join(repo, "dist"));
    await fs.appendFile(path.join(repo, ".git/info/exclude"), "\ndist\n");
    await expect(updateRelease(options, { run })).rejects.toThrow("Symlinks");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
    expect(await fs.readFile(path.join(repo, "node_modules/prior"), "utf8")).toBe("old dependencies");
    expect(await fs.readFile(path.join(directory, "external-build/keep"), "utf8")).toBe("untouched");
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("candidate");
  });
  it.each(["main", "latest", "v1.1.0-beta.1", "v01.1.0"])("rejects a nonstable or imprecise target %s", async (to) => {
    await expect(updateRelease({ ...options, to }, { run })).rejects.toThrow("stabiles Tag");
    expect(calls).toHaveLength(0);
  });
  it("rejects wrong commit, dirty worktrees, and backup destinations inside the checkout", async () => {
    await expect(updateRelease({ ...options, commit: oldCommit }, { run })).rejects.toThrow("erwarteter Commit");
    await fs.writeFile(path.join(repo, "untracked"), "local");
    await expect(updateRelease(options, { run })).rejects.toThrow("lokale Änderungen");
    await fs.rm(path.join(repo, "untracked"));
    await expect(updateRelease({ ...options, backupDir: path.join(repo, "data/backups") }, { run })).rejects.toThrow(
      "außerhalb",
    );
    expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
  });
  it("rejects downgrades even when tag, commit and target package match", async () => {
    await git(repo, "fetch", "origin", "main");
    await git(repo, "checkout", "--detach", "FETCH_HEAD");
    await expect(updateRelease({ ...options, to: "v1.0.0", commit: oldCommit, check: true }, { run })).rejects.toThrow(
      "Downgrade",
    );
  });
  async function versionScenario(current, target) {
    for (const [cwd, version] of [
      [repo, current],
      [source, target],
    ]) {
      await git(cwd, "config", "user.email", "fixture@example.invalid");
      await git(cwd, "config", "user.name", "Release Fixture");
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
      await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ ...pkg, version }));
      await git(cwd, "commit", "-am", "version scenario");
    }
    oldCommit = await git(repo, "rev-parse", "HEAD");
    commit = await git(source, "rev-parse", "HEAD");
    await git(source, "tag", `v${target}`);
    return { ...options, to: `v${target}`, commit };
  }
  it("migrates exactly legacy 2.8.0 to 0.1.0 with backup and intact company data", async () => {
    const migration = await versionScenario("2.8.0", "0.1.0");
    const result = await updateRelease(migration, { run });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(commit);
    expect(await fs.readFile(db, "utf8")).toBe("unchanged database");
    expect(await fs.stat(path.join(result.backupDirectory, "backup.tar.gz"))).toBeTruthy();
    expect(calls.findIndex((c) => c.command === process.execPath)).toBeLessThan(
      calls.findIndex((c) => c.command === "pnpm" && c.args[0] === "install"),
    );
  });
  it.each([
    ["2.7.0", "0.1.0"],
    ["2.8.1", "0.1.0"],
    ["2.8.0", "0.0.1"],
    ["2.8.0", "0.2.0"],
    ["0.1.1", "0.1.0"],
    ["0.1.0", "2.8.0"],
    ["0.2.0", "2.8.0"],
  ])("rejects non-migration or retired target %s → %s before backup", async (current, target) => {
    const scenario = await versionScenario(current, target);
    await expect(updateRelease(scenario, { run })).rejects.toThrow("Downgrade");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(oldCommit);
    expect(calls.some((c) => c.command === process.execPath || c.command === "pnpm")).toBe(false);
  });
  it("requires explicit manual service confirmation before backup or installation", async () => {
    await expect(updateRelease({ ...options, confirmStopped: false }, { run })).rejects.toThrow("--confirm-stopped");
    expect(calls.some((c) => c.command === process.execPath || c.command === "pnpm")).toBe(false);
  });
});
it("passes only the minimal child environment, not provider keys or database configuration", () => {
  expect(
    cleanEnvironment({
      PATH: "/tools",
      HOME: "/service",
      OPENAI_API_KEY: "secret",
      DB_PATH: "/production",
      NODE_OPTIONS: "--require attacker",
      GIT_CONFIG_COUNT: "1",
    }),
  ).toEqual({
    PATH: "/tools",
    HOME: "/service",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_manage_package_manager_versions: "false",
  });
});
it("fails closed on unknown or active service states and accepts only an unloaded launchd service", async () => {
  await expect(
    assertStopped({ serviceManager: "systemd" }, async () => ({
      status: 0,
      stdout: "LoadState=loaded\nActiveState=active\nSubState=running",
      stderr: "",
    })),
  ).rejects.toThrow("stillstand");
  await assertStopped({ serviceManager: "systemd" }, async () => ({
    status: 0,
    stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead",
    stderr: "",
  }));
  await expect(
    assertStopped({ serviceManager: "launchd" }, async () => ({ status: 1, stdout: "", stderr: "permission denied" })),
  ).rejects.toThrow("bootout");
  await assertStopped({ serviceManager: "launchd" }, async () => ({
    status: 113,
    stdout: "",
    stderr: 'Could not find service "eu.irongeeks.ironcrew"',
  }));
});
it("resolves only the published stable official manifest and never sends an authorization header", async () => {
  const sha = "a".repeat(40),
    asset = "https://github.com/irongeeks/ironcrew/releases/download/v1.1.0/release-manifest.json";
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new globalThis.Response(
      JSON.stringify(
        url === asset
          ? { schemaVersion: 1, version: "1.1.0", tag: "v1.1.0", commit: sha }
          : {
              tag_name: "v1.1.0",
              draft: false,
              prerelease: false,
              assets: [{ name: "release-manifest.json", browser_download_url: asset }],
            },
      ),
    );
  };
  expect(await publishedCommit("v1.1.0", "https://github.com/irongeeks/ironcrew.git", fetcher)).toBe(sha);
  expect(requests).toHaveLength(2);
  expect(requests.every((r) => !("Authorization" in r.options.headers))).toBe(true);
  await expect(publishedCommit("v1.1.0", "https://example.invalid/other.git", fetcher)).rejects.toThrow("offiziellen");
});

it("bounds an unresponsive installation subprocess without exposing output", async () => {
  await expect(execute(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 })).rejects.toThrow(
    "Zeit- oder Ausgabelimit",
  );
});

it("blocks a forgotten active native runner even when the control plane is stopped", async () => {
  await expect(
    assertStopped({ serviceManager: "systemd" }, async (_command, args) => ({
      status: 0,
      stdout: `LoadState=loaded\nActiveState=${args.at(-1) === "ironcrew-runner.service" ? "active" : "inactive"}\nSubState=${args.at(-1) === "ironcrew-runner.service" ? "running" : "dead"}`,
      stderr: "",
    })),
  ).rejects.toThrow("nativen Runner");
  await assertStopped({ serviceManager: "systemd" }, async (_command, args) => ({
    status: 0,
    stdout:
      args.at(-1) === "ironcrew-runner.service"
        ? "LoadState=not-found"
        : "LoadState=loaded\nActiveState=inactive\nSubState=dead",
    stderr: "",
  }));
});
