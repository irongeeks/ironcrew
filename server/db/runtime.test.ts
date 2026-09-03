import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function importRuntimeModule() {
  vi.resetModules();
  return import("./runtime.ts");
}

describe("db runtime", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("readNonNegativeIntEnv는 음수/비수치 입력을 fallback으로 처리한다", async () => {
    const runtime = await importRuntimeModule();

    delete process.env.TEST_NON_NEGATIVE_INT;
    expect(runtime.readNonNegativeIntEnv("TEST_NON_NEGATIVE_INT", 7)).toBe(7);

    process.env.TEST_NON_NEGATIVE_INT = "12.9";
    expect(runtime.readNonNegativeIntEnv("TEST_NON_NEGATIVE_INT", 0)).toBe(12);

    process.env.TEST_NON_NEGATIVE_INT = "-5";
    expect(runtime.readNonNegativeIntEnv("TEST_NON_NEGATIVE_INT", 3)).toBe(3);

    process.env.TEST_NON_NEGATIVE_INT = "not-a-number";
    expect(runtime.readNonNegativeIntEnv("TEST_NON_NEGATIVE_INT", 9)).toBe(9);
  });

  it("SQLITE/REVIEW guardrail 상수가 상한/하한으로 clamp 된다", async () => {
    process.env.SQLITE_BUSY_RETRY_MAX_ATTEMPTS = "999";
    process.env.REVIEW_MAX_ROUNDS = "1";
    process.env.REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND = "99";

    const runtime = await importRuntimeModule();
    expect(runtime.SQLITE_BUSY_RETRY_MAX_ATTEMPTS).toBe(20);
    expect(runtime.REVIEW_MAX_ROUNDS).toBe(3);
    expect(runtime.REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND).toBe(10);
  });

  it("initializeDatabaseRuntime는 DB/로그 디렉터리를 초기화한다", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octooffice-runtime-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const logsDir = path.join(tmpDir, "logs");
    process.env.DB_PATH = dbPath;
    process.env.LOGS_DIR = logsDir;

    const runtime = await importRuntimeModule();
    const initialized = runtime.initializeDatabaseRuntime();

    expect(initialized.dbPath).toBe(dbPath);
    expect(initialized.logsDir).toBe(logsDir);
    expect(fs.existsSync(logsDir)).toBe(true);

    initialized.db.close();
  });
});
