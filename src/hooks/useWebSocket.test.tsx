import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { useWebSocket } from "./useWebSocket";
import { bootstrapSession } from "../api";

vi.mock("../api", () => ({
  bootstrapSession: vi.fn(),
}));

const bootstrapSessionMock = vi.mocked(bootstrapSession);

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  send(): void {
    // no-op
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitClose(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitRawMessage(raw: string): void {
    this.onmessage?.({ data: raw });
  }
}

function Harness(props: { onTaskUpdate: (payload: unknown) => void }) {
  const { connected, on } = useWebSocket();

  useEffect(() => {
    return on("task_update", props.onTaskUpdate);
  }, [on, props.onTaskUpdate]);

  return <div data-testid="connected">{connected ? "connected" : "disconnected"}</div>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useWebSocket", () => {
  beforeEach(() => {
    bootstrapSessionMock.mockReset();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bootstrap 실패 시 연결하지 않고 재시도한다", async () => {
    vi.useFakeTimers();
    bootstrapSessionMock.mockResolvedValue(false);
    const onTaskUpdate = vi.fn();

    render(<Harness onTaskUpdate={onTaskUpdate} />);

    await act(async () => {
      await flushMicrotasks();
    });
    expect(bootstrapSessionMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();
    });

    expect(bootstrapSessionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(screen.getByTestId("connected").textContent).toBe("disconnected");
  });

  it("연결 성공 후 이벤트를 타입별 리스너에 전달한다", async () => {
    bootstrapSessionMock.mockResolvedValue(true);
    const onTaskUpdate = vi.fn();

    render(<Harness onTaskUpdate={onTaskUpdate} />);

    await act(async () => {
      await flushMicrotasks();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.emitOpen();
    });
    expect(screen.getByTestId("connected").textContent).toBe("connected");

    act(() => {
      ws.emitMessage({ type: "task_update", payload: { id: "task-1" } });
    });
    expect(onTaskUpdate).toHaveBeenCalledWith({ id: "task-1" });
  });

  it("소켓 종료 후 재연결 타이머가 동작하고 malformed JSON은 무시한다", async () => {
    vi.useFakeTimers();
    bootstrapSessionMock.mockResolvedValue(true);
    const onTaskUpdate = vi.fn();

    render(<Harness onTaskUpdate={onTaskUpdate} />);

    await act(async () => {
      await flushMicrotasks();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.emitOpen();
      ws.emitRawMessage("not-json");
      ws.emitMessage({ type: "unknown_event", payload: { ok: true } });
    });
    expect(onTaskUpdate).not.toHaveBeenCalled();

    act(() => {
      ws.emitClose();
    });
    expect(screen.getByTestId("connected").textContent).toBe("disconnected");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();
    });

    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("1008 unauthorized 종료 뒤에는 강제 세션 bootstrap으로 재시도한다", async () => {
    vi.useFakeTimers();
    bootstrapSessionMock.mockResolvedValue(true);
    const onTaskUpdate = vi.fn();

    render(<Harness onTaskUpdate={onTaskUpdate} />);

    await act(async () => {
      await flushMicrotasks();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(bootstrapSessionMock).toHaveBeenNthCalledWith(1, {
      promptOnUnauthorized: false,
      force: false,
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.emitClose(1008);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();
    });

    expect(bootstrapSessionMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(bootstrapSessionMock.mock.calls[1]?.[0]).toEqual({
      promptOnUnauthorized: false,
      force: true,
    });
  });

  it("강제 bootstrap이 에러나면 다음 재시도에서는 force를 해제한다", async () => {
    vi.useFakeTimers();
    bootstrapSessionMock
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("bootstrap failed"))
      .mockResolvedValueOnce(true);
    const onTaskUpdate = vi.fn();

    render(<Harness onTaskUpdate={onTaskUpdate} />);

    await act(async () => {
      await flushMicrotasks();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.emitClose(1008);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();
    });
    expect(bootstrapSessionMock.mock.calls[1]?.[0]).toEqual({
      promptOnUnauthorized: false,
      force: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      await flushMicrotasks();
    });
    expect(bootstrapSessionMock.mock.calls[2]?.[0]).toEqual({
      promptOnUnauthorized: false,
      force: false,
    });
  });
});
