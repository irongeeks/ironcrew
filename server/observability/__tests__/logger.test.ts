import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    vi.restoreAllMocks();
  });

  it("exports a pino logger instance", async () => {
    const { logger } = await import("../logger.js");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("creates child loggers with module context", async () => {
    const { logger } = await import("../logger.js");
    const child = logger.child({ module: "test-module" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
  });

  it("respects LOG_LEVEL env var", async () => {
    process.env.LOG_LEVEL = "warn";
    const { logger } = await import("../logger.js");
    expect(logger.level).toBe("warn");
  });

  it("buffers log entries before DB attachment", async () => {
    const { logger, getSqliteBuffer } = await import("../logger.js");
    logger.info({ module: "test" }, "buffered message");

    // Give pino async destination time to flush
    await new Promise((r) => setTimeout(r, 100));

    const buffer = getSqliteBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.some((e) => e.msg === "buffered message")).toBe(true);
  });

  it("flushes buffer when attachSqliteDestination is called", async () => {
    const { logger, attachSqliteDestination, getSqliteBuffer, shutdownLogger } = await import("../logger.js");

    logger.info({ module: "test" }, "pre-db message");
    await new Promise((r) => setTimeout(r, 100));

    const mockRun = vi.fn();
    const mockDb = {
      prepare: () => ({ run: mockRun }),
    };

    attachSqliteDestination(mockDb);
    shutdownLogger();

    expect(mockRun).toHaveBeenCalled();
    expect(getSqliteBuffer().length).toBe(0);
  });
});
