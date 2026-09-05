import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "./types";

export type CrewConnection = "connecting" | "live" | "reconnecting" | "disabled";
export interface CrewLiveOptions {
  enabled?: boolean;
  /** Returning false or throwing marks the snapshot as stale. */
  refresh: () => Promise<void | boolean>;
  onRunEvent?: (event: RunEvent) => void;
}

/** One company snapshot per event burst, never one per streaming token.
 * EventSource reconnects itself. On every connection we reload from persisted
 * state, including changes missed while offline or during a server restart.
 */
export function useCrewLiveUpdates({ enabled = true, refresh, onRunEvent }: CrewLiveOptions) {
  const callbacks = useRef({ refresh, onRunEvent });
  callbacks.current = { refresh, onRunEvent };
  const [connection, setConnection] = useState<CrewConnection>(enabled ? "connecting" : "disabled");
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      setConnection("disabled");
      return;
    }
    setConnection("connecting");
    let disposed = false;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let companyId: string | null = null;
    let source: EventSource;
    let repairPending = false;
    let repairAttempted = false;
    // Limit duplicate run frames without keeping an ever-growing transcript.
    const seen = new Set<string>();
    const reload = async () => {
      if (disposed || running) return;
      running = true;
      dirty = false;
      try {
        const result = await callbacks.current.refresh();
        if (!disposed) {
          setRefreshError(result === false);
          if (result !== false) {
            setLastSuccessAt(Date.now());
            if (repairPending) {
              repairPending = false;
              source.close();
              open();
            }
          }
        }
      } catch {
        if (!disposed) setRefreshError(true);
      } finally {
        running = false;
        if (dirty && !disposed) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (disposed || running || timer !== undefined) return;
      // Bounded batching, triggered only by a server event (no interval).
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, 120);
    };
    const open = () => {
      source = new EventSource("/api/crew/events", { withCredentials: true });
      source.addEventListener("connected", (event: MessageEvent<string>) => {
        try {
          const data: unknown = JSON.parse(event.data);
          if (!data || typeof data !== "object" || !("companyId" in data) || typeof data.companyId !== "string") return;
          companyId = data.companyId;
          repairAttempted = false;
          seen.clear();
          setConnection("live");
          schedule();
        } catch {
          setRefreshError(true);
        }
      });
      source.addEventListener("crew", (event: MessageEvent<string>) => {
        try {
          const data: unknown = JSON.parse(event.data);
          if (!isFrame(data) || data.companyId !== companyId) return;
          if (data.type === "crew_run_event") {
            if (!isRunEvent(data.runEvent) || seen.has(data.runEvent.eventId)) return;
            seen.add(data.runEvent.eventId);
            if (seen.size > 1024) seen.delete(seen.values().next().value!);
            callbacks.current.onRunEvent?.(data.runEvent);
            // Transcript-only deltas do not change the company snapshot.
            if (data.runEvent.type === "message.delta") return;
          }
          schedule();
        } catch {
          setRefreshError(true);
        }
      });
      source.onerror = () => {
        if (disposed) return;
        setConnection("reconnecting");
        // HTTP 401 closes EventSource permanently. A REST refresh uses the
        // normal session-bootstrap/re-auth transport; reopen once if it succeeds.
        // Further terminal failures require a successful connection first, so
        // rejected credentials never become an automatic request loop.
        if (source.readyState === EventSource.CLOSED && !repairAttempted) {
          repairAttempted = true;
          repairPending = true;
          schedule();
        }
      };
    };
    open();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      source.close();
    };
  }, [enabled]);

  return { connection, lastSuccessAt, refreshError };
}

function isFrame(value: unknown): value is { companyId: string; type: string; runEvent?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    "companyId" in value &&
    typeof value.companyId === "string" &&
    "type" in value &&
    typeof value.type === "string" &&
    value.type.startsWith("crew_")
  );
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const redaction = event.redaction as Record<string, unknown> | undefined;
  return (
    typeof event.eventId === "string" &&
    typeof event.type === "string" &&
    typeof event.seq === "number" &&
    typeof event.timestamp === "number" &&
    typeof event.taskId === "string" &&
    typeof event.runId === "string" &&
    !!event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload) &&
    !!redaction &&
    typeof redaction.redacted === "boolean" &&
    Array.isArray(redaction.rules) &&
    redaction.rules.every((rule: unknown) => typeof rule === "string")
  );
}
