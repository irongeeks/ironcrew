import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCrewLiveUpdates } from "./useCrewLiveUpdates";

class EventSourceDouble {
  static instances: EventSourceDouble[] = [];
  static CLOSED = 2;
  readyState = 0;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  close = vi.fn();
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly options: EventSourceInit,
  ) {
    EventSourceDouble.instances.push(this);
  }
  addEventListener(type: string, callback: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, callback);
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const frame = { companyId: "company-a", type: "crew_task_changed" };
const run = (type: string, id = type) => ({
  companyId: "company-a",
  type: "crew_run_event",
  runEvent: {
    eventId: id,
    type,
    seq: 1,
    timestamp: 123,
    taskId: "task-a",
    runId: "run-a",
    payload: {},
    redaction: { redacted: false, rules: [] },
  },
});
const advance = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
const source = () => EventSourceDouble.instances.at(-1)!;
const connect = () => act(() => source().emit("connected", { companyId: "company-a", resync: true }));

describe("crew live snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    EventSourceDouble.instances = [];
    vi.stubGlobal("EventSource", EventSourceDouble);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces mutations and resynchronizes on reconnect without polling", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useCrewLiveUpdates({ refresh }));
    expect(source().url).toBe("/api/crew/events");
    expect(source().options.withCredentials).toBe(true);
    connect();
    act(() => {
      for (let i = 0; i < 100; i++) source().emit("crew", frame);
    });
    await advance();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.lastSuccessAt).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => source().onerror?.());
    expect(result.current.connection).toBe("reconnecting");
    connect();
    await advance();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe("live");
    unmount();
    expect(source().close).toHaveBeenCalledOnce();
  });

  it("streams unique token events without refreshing the whole company", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    const onRunEvent = vi.fn();
    renderHook(() => useCrewLiveUpdates({ refresh, onRunEvent }));
    connect();
    await advance();
    refresh.mockClear();
    act(() => {
      for (let i = 0; i < 100; i++) source().emit("crew", run("message.delta", String(i)));
      source().emit("crew", run("message.delta", "99"));
    });
    await advance();
    expect(onRunEvent).toHaveBeenCalledTimes(100);
    expect(refresh).not.toHaveBeenCalled();
    act(() => source().emit("crew", run("run.completed")));
    await advance();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not lose events arriving during a slow refresh or overlap requests", async () => {
    let resolve!: () => void;
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(true);
    renderHook(() => useCrewLiveUpdates({ refresh }));
    connect();
    await advance();
    act(() => {
      source().emit("crew", frame);
      source().emit("crew", frame);
    });
    await advance();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await advance();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reports snapshot errors and recovers with the next event", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(true);
    const { result } = renderHook(() => useCrewLiveUpdates({ refresh }));
    connect();
    await advance();
    expect(result.current.refreshError).toBe(true);
    expect(result.current.lastSuccessAt).toBeNull();
    act(() => source().emit("crew", frame));
    await advance();
    expect(result.current.refreshError).toBe(true);
    act(() => source().emit("crew", frame));
    await advance();
    expect(result.current.refreshError).toBe(false);
    expect(result.current.lastSuccessAt).not.toBeNull();
  });

  it("ignores other-company/malformed events and closes without late refresh", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    const { unmount } = renderHook(() => useCrewLiveUpdates({ refresh }));
    connect();
    await advance();
    refresh.mockClear();
    act(() => {
      source().emit("crew", { ...frame, companyId: "other" });
      source().emit("crew", { ...frame, type: "crew_run_event", runEvent: {} });
    });
    await advance();
    expect(refresh).not.toHaveBeenCalled();
    act(() => source().emit("crew", frame));
    unmount();
    await advance();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("repairs a terminal stream failure once through the normal REST transport", async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    renderHook(() => useCrewLiveUpdates({ refresh }));
    const initial = source();
    act(() => {
      initial.readyState = EventSourceDouble.CLOSED;
      initial.onerror?.();
    });
    await advance();
    expect(refresh).toHaveBeenCalledOnce();
    expect(initial.close).toHaveBeenCalledOnce();
    expect(EventSourceDouble.instances).toHaveLength(2);
    act(() => {
      source().readyState = EventSourceDouble.CLOSED;
      source().onerror?.();
    });
    await advance();
    expect(refresh).toHaveBeenCalledOnce();
    expect(EventSourceDouble.instances).toHaveLength(2);
  });

  it("uses current callbacks and does not open a stream when disabled", async () => {
    const first = vi.fn().mockResolvedValue(true);
    const second = vi.fn().mockResolvedValue(true);
    const { rerender, result } = renderHook(({ enabled, refresh }) => useCrewLiveUpdates({ enabled, refresh }), {
      initialProps: { enabled: false, refresh: first },
    });
    expect(EventSourceDouble.instances).toHaveLength(0);
    expect(result.current.connection).toBe("disabled");
    rerender({ enabled: true, refresh: first });
    connect();
    rerender({ enabled: true, refresh: second });
    await advance();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(EventSourceDouble.instances).toHaveLength(1);
  });
});
