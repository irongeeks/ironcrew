import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createWsHub } from "./hub.ts";

type MockWs = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
};

function parseMessage(raw: string): { type: string; payload: unknown; ts: number } {
  return JSON.parse(raw) as { type: string; payload: unknown; ts: number };
}

describe("createWsHub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("일반 이벤트는 즉시 broadcast한다", () => {
    const hub = createWsHub(() => 1000);
    const wsOpen: MockWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    };
    const wsClosed: MockWs = {
      readyState: WebSocket.CLOSED,
      send: vi.fn(),
    };

    hub.wsClients.add(wsOpen as unknown as WebSocket);
    hub.wsClients.add(wsClosed as unknown as WebSocket);

    hub.broadcast("task_update", { id: "t-1" });

    expect(wsOpen.send).toHaveBeenCalledTimes(1);
    expect(wsClosed.send).not.toHaveBeenCalled();
    const envelope = parseMessage(String(wsOpen.send.mock.calls[0]?.[0]));
    expect(envelope).toMatchObject({
      type: "task_update",
      payload: { id: "t-1" },
      ts: 1000,
    });
  });

  it("cli_output은 첫 이벤트 즉시 전송 후 batch window에서 flush한다", async () => {
    const hub = createWsHub(() => 2000);
    const wsOpen: MockWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    };
    hub.wsClients.add(wsOpen as unknown as WebSocket);

    hub.broadcast("cli_output", { seq: 1 });
    hub.broadcast("cli_output", { seq: 2 });
    hub.broadcast("cli_output", { seq: 3 });

    expect(wsOpen.send).toHaveBeenCalledTimes(1);
    expect(parseMessage(String(wsOpen.send.mock.calls[0]?.[0])).payload).toEqual({ seq: 1 });

    await vi.advanceTimersByTimeAsync(260);

    expect(wsOpen.send).toHaveBeenCalledTimes(3);
    const payloads = wsOpen.send.mock.calls.map((call) => parseMessage(String(call[0])).payload);
    expect(payloads).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });

  it("batch queue cap(200)을 넘으면 가장 오래된 항목부터 버린다", async () => {
    const hub = createWsHub(() => 3000);
    const wsOpen: MockWs = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
    };
    hub.wsClients.add(wsOpen as unknown as WebSocket);

    hub.broadcast("cli_output", { seq: 0 });
    for (let i = 1; i <= 220; i += 1) {
      hub.broadcast("cli_output", { seq: i });
    }

    await vi.advanceTimersByTimeAsync(260);

    expect(wsOpen.send).toHaveBeenCalledTimes(201);
    const payloads = wsOpen.send.mock.calls.map((call) => parseMessage(String(call[0])).payload as { seq: number });
    const seqs = payloads.map((payload) => payload.seq);

    expect(seqs[0]).toBe(0);
    expect(seqs.includes(220)).toBe(true);
    expect(seqs.includes(1)).toBe(false);
    expect(seqs.includes(20)).toBe(false);
    expect(seqs.includes(21)).toBe(true);
  });

  describe("log subscription", () => {
    it("only sends log_stream to subscribed clients", async () => {
      const { wsClients, broadcast, handleClientMessage } = createWsHub(() => Date.now());
      const subscribed: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      const unsubscribed: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      wsClients.add(subscribed as unknown as WebSocket);
      wsClients.add(unsubscribed as unknown as WebSocket);

      handleClientMessage(subscribed as unknown as WebSocket, JSON.stringify({ type: "subscribe_logs" }));
      broadcast("log_stream", { level: 30, msg: "test" });
      // log_stream has 500ms batch interval — first event sent immediately to subscribers
      expect(subscribed.send).toHaveBeenCalledTimes(1);
      expect(unsubscribed.send).not.toHaveBeenCalled();
    });

    it("stops sending log_stream after unsubscribe", async () => {
      const { wsClients, broadcast, handleClientMessage } = createWsHub(() => Date.now());
      const client: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      wsClients.add(client as unknown as WebSocket);

      handleClientMessage(client as unknown as WebSocket, JSON.stringify({ type: "subscribe_logs" }));
      broadcast("log_stream", { level: 30, msg: "first" });
      expect(client.send).toHaveBeenCalledTimes(1);

      // Wait for batch window to close
      await vi.advanceTimersByTimeAsync(600);

      handleClientMessage(client as unknown as WebSocket, JSON.stringify({ type: "unsubscribe_logs" }));
      broadcast("log_stream", { level: 30, msg: "second" });
      expect(client.send).toHaveBeenCalledTimes(1); // still 1 — second not sent
    });

    it("sends non-log_stream events to all clients regardless of subscription", () => {
      const { wsClients, broadcast } = createWsHub(() => Date.now());
      const client: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      wsClients.add(client as unknown as WebSocket);

      broadcast("task_update", { id: "test" });
      // task_update is not batched and not subscription-only, should be sent immediately
      expect(client.send).toHaveBeenCalledTimes(1);
    });

    it("ignores malformed client messages", () => {
      const { handleClientMessage } = createWsHub(() => Date.now());
      const client: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      // Should not throw
      expect(() => handleClientMessage(client as unknown as WebSocket, "not json")).not.toThrow();
      expect(() => handleClientMessage(client as unknown as WebSocket, "")).not.toThrow();
    });

    it("batches log_stream events with 500ms interval", async () => {
      const { wsClients, broadcast, handleClientMessage } = createWsHub(() => Date.now());
      const client: MockWs = { readyState: WebSocket.OPEN, send: vi.fn() };
      wsClients.add(client as unknown as WebSocket);

      handleClientMessage(client as unknown as WebSocket, JSON.stringify({ type: "subscribe_logs" }));

      broadcast("log_stream", { level: 30, msg: "first" });
      broadcast("log_stream", { level: 30, msg: "second" });
      broadcast("log_stream", { level: 30, msg: "third" });

      // First sent immediately, rest batched
      expect(client.send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(510);
      expect(client.send).toHaveBeenCalledTimes(3);
    });
  });
});
