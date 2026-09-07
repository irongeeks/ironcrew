import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, symlink, readFile, mkdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workspace, digest } from "../../packages/tools/workspace.ts";
let directory: string, workspace: Workspace;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-tools-"));
  workspace = new Workspace(path.join(directory, "workspace"));
  await workspace.init();
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
it("lists bounded permitted children without leaking secret paths or following links", async () => {
  await workspace.applyPatch({
    files: [
      { path: "src/main.ts", content: "hello", expectedSha256: null },
      { path: "README.md", content: "read me", expectedSha256: null },
    ],
  });
  await writeFile(path.join(workspace.root, ".env"), "secret");
  await mkdir(path.join(workspace.root, ".git"));
  await writeFile(path.join(directory, "private"), "secret");
  await symlink(path.join(directory, "private"), path.join(workspace.root, "escape"));
  await link(path.join(directory, "private"), path.join(workspace.root, "hardlink"));
  expect(await workspace.list()).toEqual({
    path: "",
    entries: [
      { path: "README.md", type: "file", bytes: 7 },
      { path: "src", type: "directory", bytes: 0 },
    ],
    truncated: false,
  });
  expect(await workspace.list({ path: "src" })).toEqual({
    path: "src",
    entries: [{ path: "src/main.ts", type: "file", bytes: 5 }],
    truncated: false,
  });
  expect(await workspace.list({ limit: 1 })).toMatchObject({ entries: [{ path: "README.md" }], truncated: true });
  for (const value of ["..", ".git", "escape", "", "/tmp", "src/../src"])
    await expect(workspace.list({ path: value })).rejects.toThrow();
  await expect(workspace.list({ path: "README.md" })).rejects.toThrow("directory_required");
  await expect(workspace.list({ limit: 501 })).rejects.toThrow();
});
it("blocks traversal, windows aliases, symlinks and partial conflicting patches", async () => {
  await writeFile(path.join(directory, "secret"), "forbidden");
  await symlink(path.join(directory, "secret"), path.join(workspace.root, "escape"));
  for (const p of ["../secret", "/tmp/secret", "C:\\Windows\\a", "con", "a/../secret", "escape"])
    await expect(workspace.read(p)).rejects.toThrow();
  await workspace.applyPatch({ files: [{ path: "a.txt", content: "before", expectedSha256: null }] });
  await expect(
    workspace.applyPatch({
      files: [
        { path: "a.txt", content: "changed", expectedSha256: digest("before") },
        { path: "b.txt", content: "new", expectedSha256: digest("wrong") },
      ],
    }),
  ).rejects.toThrow("file_conflict");
  expect((await workspace.read("a.txt")).content).toBe("before");
});
it("runs only registered real tests with a clean restricted process", async () => {
  const code =
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('actual result',()=>assert.equal(readFileSync(new URL('./result.txt',import.meta.url),'utf8'),'created')); test('clean environment',()=>assert.equal(process.env.IRONCREW_TEST_SECRET,undefined));";
  await workspace.applyPatch({
    files: [
      { path: "check.test.mjs", content: code, expectedSha256: null },
      { path: "result.txt", content: "created", expectedSha256: null },
    ],
  });
  process.env.IRONCREW_TEST_SECRET = "must-not-inherit";
  const evidence = await workspace.testFixture("check.test.mjs", digest(code));
  delete process.env.IRONCREW_TEST_SECRET;
  expect(evidence.exitCode).toBe(0);
  expect(evidence.stdout).toContain("actual result");
  await expect(workspace.execute({ executable: "sh" })).rejects.toThrow("isolation_profile_unverified");
  expect(await readFile(path.join(workspace.root, "result.txt"), "utf8")).toBe("created");
});
