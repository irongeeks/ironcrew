import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { RunnerConnection } from "../runner-session.ts";
import { z } from "zod";
export const channelFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), channelId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("data"), channelId: z.string().uuid(), data: z.string().max(1_048_576) }).strict(),
  z.object({ kind: z.literal("close"), channelId: z.string().uuid() }).strict(),
]);
/** Logical v2 connection; dropping the uplink closes every stream, never replays jobs. */
export class FleetChannel extends EventEmitter implements RunnerConnection {
  private closed = false;
  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    private readonly cleanup: () => void,
  ) {
    super();
  }
  write(data: string): void {
    if (this.closed) throw new Error("Fleet channel closed");
    sendFrame(this.ws, { kind: "data", channelId: this.id, data });
  }
  receive(data: string): void {
    if (!this.closed) this.emit("data", data);
  }
  destroy(): void {
    this.finish(true);
  }
  disconnect(): void {
    this.finish(false);
  }
  private finish(notify: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    if (notify && this.ws.readyState === 1) sendFrame(this.ws, { kind: "close", channelId: this.id });
    this.emit("close");
  }
}
export function sendFrame(ws: WebSocket, frame: unknown): void {
  if (ws.readyState !== 1) throw new Error("Fleet uplink closed");
  if (ws.bufferedAmount > 4 * 1024 * 1024) {
    ws.terminate();
    throw new Error("Fleet uplink backpressure limit exceeded");
  }
  ws.send(JSON.stringify(frame));
}
