import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger before importing module
const mockFatal = vi.fn();
const mockError = vi.fn();
const mockInfo = vi.fn();
vi.mock("../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      info: mockInfo,
      warn: vi.fn(),
      error: mockError,
      fatal: mockFatal,
    }),
  },
}));

describe("process-level error handlers", () => {
  const originalListeners = {
    uncaughtException: [] as NodeJS.UncaughtExceptionListener[],
    unhandledRejection: [] as NodeJS.UnhandledRejectionListener[],
  };

  let mockExit: any;

  beforeEach(() => {
    // Save existing listeners
    originalListeners.uncaughtException = process.listeners("uncaughtException") as NodeJS.UncaughtExceptionListener[];
    originalListeners.unhandledRejection = process.listeners(
      "unhandledRejection",
    ) as NodeJS.UnhandledRejectionListener[];
    // Stub process.exit to prevent actually exiting during tests
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExit.mockRestore();
    // Restore original listeners
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
    for (const fn of originalListeners.uncaughtException) {
      process.on("uncaughtException", fn);
    }
    for (const fn of originalListeners.unhandledRejection) {
      process.on("unhandledRejection", fn);
    }
  });

  it("registers uncaughtException handler", async () => {
    const { registerGracefulShutdownHandlers } = await import("../../modules/lifecycle/register-graceful-shutdown.ts");

    const gracefulShutdownSpy = vi.fn();
    const mockOpts = createMockOptions(gracefulShutdownSpy);

    registerGracefulShutdownHandlers(mockOpts);

    const listeners = process.listeners("uncaughtException");
    expect(listeners.length).toBeGreaterThan(0);
  });

  it("registers unhandledRejection handler", async () => {
    const { registerGracefulShutdownHandlers } = await import("../../modules/lifecycle/register-graceful-shutdown.ts");

    const mockOpts = createMockOptions();
    registerGracefulShutdownHandlers(mockOpts);

    const listeners = process.listeners("unhandledRejection");
    expect(listeners.length).toBeGreaterThan(0);
  });

  it("uncaughtException triggers shutdown with exit code 1", async () => {
    const { registerGracefulShutdownHandlers } = await import("../../modules/lifecycle/register-graceful-shutdown.ts");

    const mockOpts = createMockOptions();
    registerGracefulShutdownHandlers(mockOpts);

    // Emit uncaughtException
    process.emit("uncaughtException", new Error("test crash"));

    expect(mockFatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("uncaught exception"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("unhandledRejection triggers shutdown with exit code 1", async () => {
    const { registerGracefulShutdownHandlers } = await import("../../modules/lifecycle/register-graceful-shutdown.ts");

    const mockOpts = createMockOptions();
    registerGracefulShutdownHandlers(mockOpts);

    // Emit unhandledRejection
    process.emit("unhandledRejection", new Error("test rejection"), Promise.resolve());

    expect(mockFatal).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("unhandled promise rejection"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("SIGINT/SIGTERM triggers shutdown with exit code 0", async () => {
    const { registerGracefulShutdownHandlers } = await import("../../modules/lifecycle/register-graceful-shutdown.ts");

    const mockOpts = createMockOptions();
    registerGracefulShutdownHandlers(mockOpts);

    // Emit SIGTERM — gracefulShutdown defaults to exitCode 0
    process.emit("SIGTERM");

    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

function createMockOptions(onShutdown?: () => void) {
  return {
    activeProcesses: new Map(),
    stopRequestedTasks: new Set<string>(),
    killPidTree: vi.fn(),
    rollbackTaskWorktree: vi.fn(),
    db: {
      prepare: vi.fn().mockReturnValue({ get: vi.fn(), run: vi.fn() }),
      close: vi.fn(),
    } as any,
    nowMs: () => Date.now(),
    endTaskExecutionSession: vi.fn(),
    wsClients: new Set() as any,
    wss: { close: vi.fn((cb: () => void) => cb()) } as any,
    server: { close: vi.fn((cb: () => void) => cb()) } as any,
    onBeforeClose: onShutdown,
  };
}
