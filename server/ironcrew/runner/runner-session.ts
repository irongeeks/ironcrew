/**
 * IronCrew — one connection to the runner, with the handshake already done.
 *
 * Extracted from runner-client.ts when a second caller appeared (MCP servers,
 * see runner-mcp-client.ts). Two copies of a handshake is how two sides of a
 * protocol drift apart: the copy that is used less gets fixed later, or not
 * at all. So the greeting, the token, the line decoding and the timeout live
 * here exactly once.
 *
 * The transport is injected as a plain duplex-ish pair rather than a socket,
 * so tests drive the real code with no filesystem and no ports.
 */

import { decodeMessage, encodeMessage, LineDecoder, RUNNER_PROTOCOL_VERSION, type ServerMessage } from "./protocol.ts";

/** What a transport must provide. A net.Socket satisfies this; so does a fake. */
export interface RunnerConnection {
  write(data: string): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  destroy(): void;
}

export class RunnerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerUnavailableError";
  }
}

export interface Session {
  connection: RunnerConnection;
  lines: AsyncIterableIterator<string>;
  /** The runtimes this runner reported at the handshake. */
  runtimes: string[];
  close(): void;
}

export interface OpenSessionOptions {
  connect: () => Promise<RunnerConnection>;
  token: string;
  requestTimeoutMs: number;
  /** When set, the session is refused unless the runner offers this runtime. */
  requireRuntime?: string;
}

/**
 * Reads the next protocol message, or null once the connection is done.
 *
 * The timeout is a rejection rather than a null: "no answer yet" and "the
 * peer hung up" are different failures, and a caller that cannot tell them
 * apart will retry the wrong one.
 */
export async function nextMessage(session: Session, timeoutMs: number): Promise<ServerMessage | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const line = await Promise.race([
      session.lines.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RunnerUnavailableError("Der Runner antwortete nicht rechtzeitig.")),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    if (line.done) return null;
    return decodeMessage(line.value) as ServerMessage;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens a connection and completes the handshake.
 *
 * One connection per request rather than a long-lived shared one: a runner
 * restart then costs the next request a reconnect instead of silently
 * breaking every future one, and there is no shared state to get out of sync
 * between two processes that update independently.
 */
export async function openSession(opts: OpenSessionOptions): Promise<Session> {
  let connection: RunnerConnection;
  try {
    connection = await opts.connect();
  } catch (err) {
    throw new RunnerUnavailableError(`Runner nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
  }

  const decoder = new LineDecoder();
  const queue: string[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;
  let failure: Error | null = null;

  const wake = () => {
    const resolve = resolveNext;
    resolveNext = null;
    resolve?.();
  };

  connection.on("data", (chunk) => {
    try {
      queue.push(...decoder.push(chunk));
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      closed = true;
    }
    wake();
  });
  connection.on("close", () => {
    closed = true;
    wake();
  });
  connection.on("error", (err) => {
    failure = err;
    closed = true;
    wake();
  });

  async function* lines(): AsyncIterableIterator<string> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (failure) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }

  const session: Session = {
    connection,
    lines: lines(),
    runtimes: [],
    close: () => {
      closed = true;
      wake();
      connection.destroy();
    },
  };

  connection.write(encodeMessage({ v: RUNNER_PROTOCOL_VERSION, kind: "hello", token: opts.token }));

  const greeting = await nextMessage(session, opts.requestTimeoutMs);
  if (!greeting || greeting.kind !== "hello-ok") {
    session.close();
    throw new RunnerUnavailableError(
      greeting?.kind === "error" ? `Runner lehnte die Verbindung ab: ${greeting.message}` : "Runner grüßte nicht.",
    );
  }
  session.runtimes = greeting.runtimes;

  if (opts.requireRuntime && !greeting.runtimes.includes(opts.requireRuntime)) {
    session.close();
    // Better here than as a confusing failure inside a run: the runner is
    // reachable, it simply cannot do this job.
    throw new RunnerUnavailableError(
      `Der Runner kennt die Laufzeit "${opts.requireRuntime}" nicht (verfügbar: ${greeting.runtimes.join(", ") || "keine"}).`,
    );
  }
  return session;
}
