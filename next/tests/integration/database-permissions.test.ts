import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Repository } from "../../packages/persistence/src/index.ts";
import { prepareDatabaseFile } from "../../packages/persistence/src/files.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ironcrew-database-permissions-"));
  await chmod(directory, 0o755);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function expectPrivate(file: string) {
  const metadata = await stat(file);
  expect(metadata.isFile()).toBe(true);
  if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
}
async function expectDatabasePrivate(file: string) {
  for (const suffix of ["", "-wal", "-shm"]) await expectPrivate(file + suffix);
}

it("prepares a private empty file before SQLite opens it, without changing the parent or process umask", async () => {
  const file = path.join(directory, "company.sqlite");
  const mask = process.umask();
  prepareDatabaseFile(file);
  await expectPrivate(file);
  expect((await stat(file)).size).toBe(0);
  expect(process.umask()).toBe(mask);
  if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o755);
});

it("protects fresh database and WAL/SHM files in an existing permissive directory, including reopen", async () => {
  const file = path.join(directory, "company.sqlite");
  for (let attempt = 0; attempt < 2; attempt++) {
    const repo = await Repository.open(file);
    try {
      expect((await repo.health()).journalMode).toBe("wal");
      await expectDatabasePrivate(file);
    } finally {
      await repo.close();
    }
  }
});

it("repairs an existing database and live sidecars before opening another connection, preserving data", async () => {
  const file = path.join(directory, "company.sqlite");
  const original = await Repository.open(file);
  try {
    await original.setup({
      companyName: "Permission regression",
      ceoName: "Owner",
      passwordHash: "fixture",
      timezone: "UTC",
      budgetLimitUsdMicros: "1000000",
    });
    for (const suffix of ["", "-wal", "-shm"]) await chmod(file + suffix, 0o644);
    const reopened = await Repository.open(file);
    try {
      await expectDatabasePrivate(file);
      expect(await reopened.setupState()).toEqual(await original.setupState());
    } finally {
      await reopened.close();
    }
  } finally {
    await original.close();
  }
});

it("creates private new database directories and repairs existing rollback journals", async () => {
  const file = path.join(directory, "nested", "company.sqlite");
  await mkdir(path.dirname(file));
  await writeFile(file + "-journal", "interrupted journal", { mode: 0o644 });
  prepareDatabaseFile(file);
  await expectPrivate(file + "-journal");
  const fresh = path.join(directory, "new", "company.sqlite");
  prepareDatabaseFile(fresh);
  if (process.platform !== "win32") expect((await stat(path.dirname(fresh))).mode & 0o777).toBe(0o700);
});

it("opens the independent updater bridge privately even with a permissive 000 umask", async () => {
  const launcher = path.join(directory, "launch-updater.mjs");
  await writeFile(
    launcher,
    `process.umask(0); await import(${JSON.stringify(pathToFileURL(path.resolve("apps/updater/database.ts")).href)});`,
  );
  const child = execFile(process.execPath, [launcher, directory], { cwd: process.cwd() });
  let stderr = "";
  child.stderr!.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Updater exited ${code}: ${stderr}`))));
  });
  const line = new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("\n")) resolve(output.split("\n")[0]!);
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Updater exited before responding")));
  });
  try {
    child.stdin!.write(JSON.stringify({ id: 1, method: "setupState", args: [] }) + "\n");
    expect(JSON.parse(await line)).toHaveProperty("result");
    await expectDatabasePrivate(path.join(directory, "company.sqlite"));
  } finally {
    child.stdin!.end();
    await completed;
  }
});
