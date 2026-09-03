import { useEffect, useRef, useCallback, useState } from "react";
import { bootstrapSession } from "../api";
import type { WSEvent, WSEventType } from "../types";

type Listener = (payload: unknown) => void;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<WSEventType, Set<Listener>>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    let alive = true;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let forceSessionBootstrap = false;

    async function connect() {
      if (!alive) return;
      const forceBootstrap = forceSessionBootstrap;
      try {
        const bootstrapped = await bootstrapSession({
          promptOnUnauthorized: false,
          force: forceBootstrap,
        });
        if (!bootstrapped) {
          reconnectTimer = setTimeout(() => {
            void connect();
          }, 2000);
          return;
        }
        forceSessionBootstrap = false;
      } catch {
        // Avoid force bootstrap busy-loop when unauthorized recovery itself fails.
        if (forceBootstrap) forceSessionBootstrap = false;
        // ignore bootstrap errors; ws connect result will drive retry
        reconnectTimer = setTimeout(() => {
          void connect();
        }, 2000);
        return;
      }
      ws = new WebSocket(url);
      wsRef.current = ws;

      const connectTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
        }
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        if (alive) setConnected(true);
      };
      ws.onclose = (event) => {
        clearTimeout(connectTimeout);
        if (!alive) return;
        setConnected(false);
        if (event.code === 1008) {
          forceSessionBootstrap = true;
        }
        reconnectTimer = setTimeout(() => {
          void connect();
        }, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        if (!alive) return;
        try {
          const evt: WSEvent = JSON.parse(e.data);
          const listeners = listenersRef.current.get(evt.type);
          if (listeners) {
            for (const fn of listeners) fn(evt.payload);
          }
        } catch {
          /* ignored */
        }
      };
    }

    void connect();
    const listeners = listenersRef.current;
    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      ws?.close();
      // Clear all listeners on unmount to prevent memory leaks
      listeners.clear();
    };
  }, []);

  const on = useCallback((type: WSEventType, fn: Listener) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type)!.add(fn);
    return () => {
      listenersRef.current.get(type)?.delete(fn);
    };
  }, []);

  return { connected, on };
}
