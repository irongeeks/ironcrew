import { WebSocket } from "ws";
import { logger } from "../observability/logger.ts";

let droppedCount = 0;

export function createWsHub(nowMs: () => number): {
  wsClients: Set<WebSocket>;
  broadcast: (type: string, payload: unknown) => void;
  handleClientMessage: (ws: WebSocket, rawMessage: string) => void;
} {
  const wsClients = new Set<WebSocket>();

  // Per-client subscription tracking for opt-in event types (e.g. log_stream)
  const subscriptions = new Map<WebSocket, Set<string>>();

  /** Event types that require explicit client subscription before delivery. */
  const SUBSCRIPTION_ONLY_TYPES = new Set(["log_stream"]);

  function sendRaw(type: string, payload: unknown): void {
    const message = JSON.stringify({ type, payload, ts: nowMs() });
    const requiresSub = SUBSCRIPTION_ONLY_TYPES.has(type);
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        if (requiresSub) {
          const subs = subscriptions.get(ws);
          if (!subs || !subs.has(type)) continue;
        }
        ws.send(message);
      } else {
        // Clean up dead clients and their subscriptions
        wsClients.delete(ws);
        subscriptions.delete(ws);
      }
    }
  }

  // Batched broadcast for high-frequency streaming event types.
  // Collects payloads during a cooldown window, then flushes them all.
  // Only truly high-frequency types are batched; agent_status is excluded
  // because it is paired with task_update (unbatched) and delaying it
  // causes visible ordering mismatches on the frontend.
  const BATCH_INTERVAL: Record<string, number> = {
    cli_output: 250, // highest frequency (process stdout/stderr streams)
    subtask_update: 150, // moderate frequency
    log_stream: 500, // log entries forwarded from pino
  };
  const MAX_BATCH_QUEUE = 200;
  const batches = new Map<string, { queue: unknown[]; timer: ReturnType<typeof setTimeout> }>();

  function broadcast(type: string, payload: unknown): void {
    const interval = BATCH_INTERVAL[type];
    if (!interval) {
      sendRaw(type, payload);
      return;
    }

    const existing = batches.get(type);
    if (existing) {
      if (existing.queue.length < MAX_BATCH_QUEUE) {
        existing.queue.push(payload);
      }
      // Over cap: shed oldest to prevent unbounded growth
      else {
        existing.queue.shift();
        existing.queue.push(payload);
        droppedCount++;
        if (droppedCount === 1 || droppedCount % 100 === 0) {
          logger.warn(
            { droppedCount, queueSize: existing.queue.length, type },
            "WS batch queue overflow — dropping oldest message",
          );
        }
      }
      return;
    }

    // First event: send immediately, then open a batch window
    sendRaw(type, payload);
    const entry: { queue: unknown[]; timer: ReturnType<typeof setTimeout> } = {
      queue: [],
      timer: setTimeout(() => {
        const items = entry.queue;
        batches.delete(type);
        for (const p of items) {
          try {
            sendRaw(type, p);
          } catch {
            /* skip failed item, continue flushing */
          }
        }
      }, interval),
    };
    batches.set(type, entry);
  }

  function handleClientMessage(ws: WebSocket, rawMessage: string): void {
    try {
      const msg = JSON.parse(rawMessage);
      if (msg.type === "subscribe_logs") {
        if (!subscriptions.has(ws)) subscriptions.set(ws, new Set());
        subscriptions.get(ws)!.add("log_stream");
      } else if (msg.type === "unsubscribe_logs") {
        subscriptions.get(ws)?.delete("log_stream");
      }
    } catch {
      // Ignore malformed messages
    }
  }

  return { wsClients, broadcast, handleClientMessage };
}
