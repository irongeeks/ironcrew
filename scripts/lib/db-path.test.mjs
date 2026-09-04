// scripts/lib/db-path.test.mjs
//
// This resolver decides which file three tools open — one of which restores
// over a database and one of which migrates its schema. "It picked the wrong
// file" is the worst outcome in this repository that is not a security bug, so
// every branch of the order is pinned here.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveDbPath, isLegacyDbPath, DB_FILE_NAME, LEGACY_DB_FILE_NAME } from "./db-path.mjs";

describe("resolveDbPath", () => {
  let cwd;
  let repoRoot;

  const touch = (...segments) => {
    const target = path.join(...segments);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
    return target;
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "db-path-cwd-"));
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "db-path-root-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("prefers --db over everything, and does not require it to exist", () => {
    touch(cwd, DB_FILE_NAME);
    const resolved = resolveDbPath({
      explicit: "./somewhere-else.sqlite",
      cwd,
      repoRoot,
      env: { DB_PATH: "/env/wins/nothing.sqlite" },
    });
    expect(resolved).toBe(path.join(cwd, "somewhere-else.sqlite"));
  });

  it("resolves a relative --db against the caller's directory, not the repo", () => {
    const resolved = resolveDbPath({ explicit: "./data.sqlite", cwd, repoRoot, env: {} });
    expect(resolved).toBe(path.join(cwd, "data.sqlite"));
  });

  it("prefers $DB_PATH over any file that happens to exist", () => {
    touch(cwd, DB_FILE_NAME);
    const resolved = resolveDbPath({ cwd, repoRoot, env: { DB_PATH: "/srv/ironcrew/live.sqlite" } });
    expect(resolved).toBe("/srv/ironcrew/live.sqlite");
  });

  it("finds the server's own default in the working directory", () => {
    const expected = touch(cwd, DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("falls back to the pre-rename file when only that exists", () => {
    const expected = touch(cwd, LEGACY_DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("prefers the current name when both exist — the legacy file is a leftover, not the truth", () => {
    const expected = touch(cwd, DB_FILE_NAME);
    touch(cwd, LEGACY_DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("finds the ./data layout the Linux install guide sets up", () => {
    const expected = touch(repoRoot, "data", DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("finds a pre-rename database inside the ./data layout too", () => {
    const expected = touch(repoRoot, "data", LEGACY_DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("prefers the working directory over ./data when both hold a database", () => {
    const expected = touch(cwd, DB_FILE_NAME);
    touch(repoRoot, "data", DB_FILE_NAME);
    expect(resolveDbPath({ cwd, repoRoot, env: {} })).toBe(expected);
  });

  it("names the preferred file when nothing exists, so the error names what is missing", () => {
    const resolved = resolveDbPath({ cwd, repoRoot, env: {} });
    expect(resolved).toBe(path.join(cwd, DB_FILE_NAME));
    expect(fs.existsSync(resolved)).toBe(false);
  });

  it("returns an absolute path in every case", () => {
    touch(cwd, LEGACY_DB_FILE_NAME);
    for (const opts of [
      { cwd, repoRoot, env: {} },
      { explicit: "x.sqlite", cwd, repoRoot, env: {} },
    ]) {
      expect(path.isAbsolute(resolveDbPath(opts))).toBe(true);
    }
  });
});

describe("isLegacyDbPath", () => {
  it("recognises the pre-rename file wherever it lives", () => {
    expect(isLegacyDbPath(`/var/lib/ironcrew/${LEGACY_DB_FILE_NAME}`)).toBe(true);
    expect(isLegacyDbPath(`/var/lib/ironcrew/${DB_FILE_NAME}`)).toBe(false);
  });

  it("does not fire on a path that merely contains the old name", () => {
    expect(isLegacyDbPath("/srv/octooffice/ironcrew.sqlite")).toBe(false);
  });
});
