/**
 * A pair of ends that write into each other, standing in for a socket.
 *
 * No filesystem, no ports — the transport is the only thing faked, so
 * everything else under test is the code that will run in production.
 * Delivery is deferred by a microtask, so ordering matches a real stream.
 *
 * `traffic` records every line in both directions. That is what makes the
 * security claims testable rather than merely stated: a test can assert that
 * a resolved credential never appears on the wire.
 */

import type { RunnerSocket } from "../runner-server.ts";
import type { RunnerConnection } from "../runner-session.ts";

export interface SocketPair {
  client: RunnerConnection;
  server: RunnerSocket;
  /** Every line written by either side, in order. */
  traffic: string[];
  dropClient(): void;
}

export function socketPair(): SocketPair {
  type Listener = (arg: never) => void;
  const listeners = { client: new Map<string, Listener[]>(), server: new Map<string, Listener[]>() };
  const traffic: string[] = [];
  let open = true;

  const emit = (side: "client" | "server", event: string, arg?: unknown) => {
    for (const listener of listeners[side].get(event) ?? []) (listener as (a: unknown) => void)(arg);
  };
  const on = (side: "client" | "server") => (event: string, listener: Listener) => {
    const bucket = listeners[side].get(event) ?? [];
    bucket.push(listener);
    listeners[side].set(event, bucket);
  };
  const close = () => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      emit("client", "close");
      emit("server", "close");
    });
  };

  return {
    client: {
      write: (data) => {
        traffic.push(data);
        if (open) queueMicrotask(() => emit("server", "data", data));
      },
      on: on("client") as RunnerConnection["on"],
      destroy: close,
    },
    server: {
      write: (data) => {
        traffic.push(data);
        if (open) queueMicrotask(() => emit("client", "data", data));
      },
      on: on("server") as RunnerSocket["on"],
      destroy: close,
    },
    traffic,
    dropClient: close,
  };
}
