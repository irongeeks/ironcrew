/** Company-scoped live invalidations. Durable event history remains in RunStore.
 * A connection (including reconnect) always asks for an authoritative REST
 * snapshot: an in-memory replay could silently miss changes during a restart.
 * This channel deliberately does not use the legacy, shared-password WebSocket.
 */
import type { Request, Response } from "express";
import { tokenFromRequest, type CrewAuth } from "../auth/crew-auth.ts";
import { runEventSchema } from "../runtime/run-events.ts";

type Listener = (frame: string) => void;

export class CrewLiveEvents {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly companyId: string) {}

  publish(type: string, payload: unknown): void {
    if (!type.startsWith("crew_")) return;
    // Only run events carry content. Other notifications are invalidations;
    // clients fetch the authorized resource instead of receiving raw payloads.
    let runEvent;
    if (type === "crew_run_event") {
      const parsed = runEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.companyId !== this.companyId) return;
      runEvent = parsed.data;
    }
    const frame = `event: crew\ndata: ${JSON.stringify({ type, companyId: this.companyId, ...(runEvent ? { runEvent } : {}) })}\n\n`;
    for (const listener of this.listeners) listener(frame);
  }

  connect(req: Request, res: Response, auth: CrewAuth): void {
    const token = tokenFromRequest(req);
    // Re-resolve for every delivery: revoked/expired sessions and accounts
    // must not keep receiving data through an already-open response.
    const authorized = () => (token ? auth.sessions.resolve(token) !== null : auth.isBootstrap());
    if (!authorized()) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.listeners.delete(deliver);
      res.end();
    };
    const deliver = (frame: string) => {
      if (closed) return;
      // Bound per-client buffering; reconnect then reload if a client cannot
      // keep up, rather than keeping unlimited token events in memory.
      if (!authorized() || res.writableLength > 256 * 1024) return close();
      res.write(frame);
    };
    // Transport keepalive, not a domain-state polling loop.
    const heartbeat = setInterval(() => deliver(": keepalive\n\n"), 25_000);
    heartbeat.unref();
    this.listeners.add(deliver);
    res.on("close", close);
    deliver(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({ companyId: this.companyId, resync: true })}\n\n`);
  }
}
