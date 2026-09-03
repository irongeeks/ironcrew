import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDecisionInboxRoutes } from "./decision-inbox-routes.ts";

const sendMessengerMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../gateway/client.ts", () => ({
  sendMessengerMessage: sendMessengerMessageMock,
}));

type FakeHandler = (req: Record<string, unknown>, res: { json: (body: unknown) => unknown }) => unknown;

function createFakeDb(): {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => { changes: number };
  };
} {
  return {
    prepare(_sql: string) {
      return {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
  };
}

function createRouteBridge() {
  const getHandlers = new Map<string, FakeHandler>();
  const postHandlers = new Map<string, FakeHandler>();

  const app = {
    get(path: string, handler: FakeHandler) {
      getHandlers.set(path, handler);
    },
    post(path: string, handler: FakeHandler) {
      postHandlers.set(path, handler);
    },
  };

  const bridge = registerDecisionInboxRoutes({
    app: app as any,
    db: createFakeDb() as any,
    nowMs: () => Date.now(),
    activeProcesses: new Map(),
    appendTaskLog: vi.fn(),
    broadcast: vi.fn(),
    finishReview: vi.fn(),
    getAgentDisplayName: vi.fn(() => "Agent"),
    getDeptName: vi.fn(() => "Department"),
    getPreferredLanguage: vi.fn(() => "en"),
    l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => ({ ko, en, ja, zh }),
    pickL: (pool: Record<string, string[]>, lang: string) => pool[lang]?.[0] ?? pool.en?.[0] ?? pool.ko?.[0] ?? "",
    findTeamLeader: vi.fn(() => null),
    normalizeTextField: (value: unknown) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    },
    processSubtaskDelegations: vi.fn(),
    resolveLang: vi.fn(() => "en"),
    runAgentOneShot: vi.fn(async () => ({ text: "" })),
    scheduleNextReviewRound: vi.fn(),
    seedReviewRevisionSubtasks: vi.fn(),
    startTaskExecutionForAgent: vi.fn(),
    chooseSafeReply: vi.fn(() => "safe-reply"),
  } as any);

  return { bridge, getHandlers, postHandlers };
}

describe("decision inbox bridge characterization", () => {
  beforeEach(() => {
    sendMessengerMessageMock.mockReset();
    sendMessengerMessageMock.mockResolvedValue(undefined);
  });

  it("non-decision text is ignored", async () => {
    const { bridge } = createRouteBridge();

    const result = await bridge.tryHandleInboxDecisionReply({
      text: "hello there",
      channel: "telegram",
      targetId: "-100123",
    });

    expect(result).toEqual({
      handled: false,
      status: 200,
      payload: {},
    });
    expect(sendMessengerMessageMock).not.toHaveBeenCalled();
  });

  it("simple numeric choice without explicit marker is ignored when no pending decision exists", async () => {
    const { bridge } = createRouteBridge();

    const result = await bridge.tryHandleInboxDecisionReply({
      text: "1",
      channel: "telegram",
      targetId: "-100123",
    });

    expect(result).toEqual({
      handled: false,
      status: 200,
      payload: {},
    });
    expect(sendMessengerMessageMock).not.toHaveBeenCalled();
  });

  it("explicit decision marker without pending decision returns 404 and sends warning message", async () => {
    const { bridge } = createRouteBridge();

    const result = await bridge.tryHandleInboxDecisionReply({
      text: "[DECISION:abc123] 승인",
      channel: "telegram",
      targetId: "-100123",
    });

    expect(result).toEqual({
      handled: true,
      status: 404,
      payload: { error: "decision_not_found_for_route" },
    });
    expect(sendMessengerMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessengerMessageMock).toHaveBeenCalledWith({
      channel: "telegram",
      targetId: "-100123",
      text: expect.stringContaining("no pending decision request"),
    });
  });
});
