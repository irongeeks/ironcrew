import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertAllMigrationFilesRegistered,
  validateMigrations,
} from "../../../modules/bootstrap/migrations/registry.ts";
import type { Migration } from "../../../modules/bootstrap/migrations/migration-types.ts";

describe("validateMigrations", () => {
  it("accepts valid sorted migrations", () => {
    const migrations: Migration[] = [
      { version: 0, description: "baseline", up: () => {} },
      { version: 1, description: "first", up: () => {} },
      { version: 2, description: "second", up: () => {} },
    ];
    expect(() => validateMigrations(migrations)).not.toThrow();
  });

  it("rejects duplicate version numbers", () => {
    const migrations: Migration[] = [
      { version: 0, description: "baseline", up: () => {} },
      { version: 1, description: "first", up: () => {} },
      { version: 1, description: "duplicate", up: () => {} },
    ];
    expect(() => validateMigrations(migrations)).toThrow("Duplicate migration version: 1");
  });

  it("rejects non-ascending versions", () => {
    const migrations: Migration[] = [
      { version: 0, description: "baseline", up: () => {} },
      { version: 2, description: "second", up: () => {} },
      { version: 1, description: "first", up: () => {} },
    ];
    expect(() => validateMigrations(migrations)).toThrow("not in ascending order");
  });

  it("accepts empty list", () => {
    expect(() => validateMigrations([])).not.toThrow();
  });
});

describe("assertAllMigrationFilesRegistered", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-scan-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes when all NNNN-*.ts files are registered", () => {
    fs.writeFileSync(path.join(tmpDir, "0000-baseline.ts"), "// stub");
    fs.writeFileSync(path.join(tmpDir, "0001-add-thing.ts"), "// stub");
    // Non-migration files must be ignored.
    fs.writeFileSync(path.join(tmpDir, "registry.ts"), "// stub");
    fs.writeFileSync(path.join(tmpDir, "runner.ts"), "// stub");
    fs.writeFileSync(path.join(tmpDir, "0001-add-thing.test.ts"), "// stub");

    expect(() => assertAllMigrationFilesRegistered(tmpDir, ["0000-baseline.ts", "0001-add-thing.ts"])).not.toThrow();
  });

  it("throws when a NNNN-*.ts file is unregistered", () => {
    fs.writeFileSync(path.join(tmpDir, "0000-baseline.ts"), "// stub");
    fs.writeFileSync(path.join(tmpDir, "0002-forgot-to-register.ts"), "// stub");

    expect(() => assertAllMigrationFilesRegistered(tmpDir, ["0000-baseline.ts"])).toThrow(
      /0002-forgot-to-register\.ts.*not registered/i,
    );
  });

  it("ignores *.test.ts files in the migrations directory", () => {
    fs.writeFileSync(path.join(tmpDir, "0000-baseline.ts"), "// stub");
    fs.writeFileSync(path.join(tmpDir, "0000-baseline.test.ts"), "// stub");

    expect(() => assertAllMigrationFilesRegistered(tmpDir, ["0000-baseline.ts"])).not.toThrow();
  });

  it("does not throw when the directory does not exist", () => {
    expect(() => assertAllMigrationFilesRegistered(path.join(tmpDir, "does-not-exist"), [])).not.toThrow();
  });
});
