/**
 * IronCrew — the wire between the control plane and the runner.
 *
 * The runner exists because the control plane must not hold the owner's CLI
 * logins (docs/THREAT_MODEL.md T-05, docs/RUNNER_PROTOCOL.md). Two processes,
 * two trust domains: the control plane knows tasks, policy and the audit log;
 * the runner knows how to execute and holds the credentials. This module is
 * the only thing they share, so it is deliberately small and deliberately
 * boring.
 *
 * NDJSON, ONE MESSAGE PER LINE
 *
 * Not a binary framing, not an RPC library. A protocol an operator can read
 * with `nc` while debugging at three in the morning is worth more than a few
 * saved bytes, and the message rate here is events from a handful of runs —
 * nowhere near where framing efficiency matters.
 *
 * The one rule that makes it safe: **a JSON string never contains a raw
 * newline**, so a line boundary is unambiguous even when a payload carries
 * multi-line agent output. `encodeMessage` asserts that rather than assuming
 * it.
 *
 * VERSIONED, BECAUSE THE TWO SIDES UPDATE SEPARATELY
 *
 * The runner runs as a different OS user, from a different systemd unit, and
 * an admin will restart one without the other. A version on every message
 * means the mismatch is reported at the handshake instead of appearing later
 * as a field that is mysteriously undefined.
 */

import type { RunEvent, RunInput, RuntimeCapabilities, RuntimeHealth, AuthStatus } from "../runtime/run-events.ts";
import type { McpServerConfig } from "../../connectors/built-in/mcp/mcp-config.ts";
import type { ConnectorCapability, ConnectorExecuteResult } from "../../connectors/connector-interface.ts";

export const RUNNER_PROTOCOL_VERSION = 1;

/** A guard against a peer that streams without newlines until memory runs out. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * The run context, minus what cannot cross a process boundary.
 *
 * `signal` is absent by construction rather than by convention: an
 * AbortSignal is a local object, and cancellation crosses the wire as its own
 * message. A type that still carried the field would invite someone to send
 * it and quietly lose the cancellation.
 */
export interface WireRunContext {
  companyId: string;
  projectId: string | null;
  taskId: string;
  runId: string;
  agentId: string | null;
  correlationId: string;
  workspacePath: string;
  permissionMode: "restricted" | "workspace_write" | "elevated";
  redactValues?: readonly string[];
}

/**
 * What the control plane learns about an MCP server it started on the runner.
 *
 * Tools, and nothing else. Not the environment it was started with, not the
 * headers it sends — those hold the credentials, and the whole point of
 * running the server over there is that they stay over there.
 */
export interface McpConnectResult {
  tools: ConnectorCapability[];
}

export type ClientMessage =
  | { v: number; kind: "hello"; token: string }
  | { v: number; kind: "capabilities"; id: string; runtimeType: string }
  | { v: number; kind: "health"; id: string; runtimeType: string }
  | { v: number; kind: "auth"; id: string; runtimeType: string }
  | { v: number; kind: "start"; id: string; runtimeType: string; input: RunInput; context: WireRunContext }
  | { v: number; kind: "cancel"; id: string; runId: string }
  // MCP servers whose credentials are SecretRefs run on the runner, because
  // that is where a vault session exists (mcp-secrets.ts). The config crosses
  // the wire with its references intact — a reference is not a secret.
  | { v: number; kind: "mcp-connect"; id: string; config: McpServerConfig }
  | { v: number; kind: "mcp-call"; id: string; server: string; tool: string; input: Record<string, unknown> }
  | { v: number; kind: "mcp-disconnect"; id: string; server: string };

export type ServerMessage =
  | { v: number; kind: "hello-ok"; runtimes: string[] }
  | {
      v: number;
      kind: "result";
      id: string;
      value: RuntimeCapabilities | RuntimeHealth | AuthStatus | McpConnectResult | ConnectorExecuteResult | null;
    }
  | { v: number; kind: "event"; id: string; event: RunEvent }
  | { v: number; kind: "end"; id: string }
  | { v: number; kind: "error"; id: string; message: string };

export class RunnerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerProtocolError";
  }
}

/**
 * Serialises one message as a single line.
 *
 * The newline assertion is not paranoia about JSON.stringify — it is a
 * tripwire for the day someone "optimises" this to interpolate a
 * pre-serialised payload. A stray newline would split one message into two
 * unparseable halves, and the failure would look like corruption rather than
 * like a bug here.
 */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  const line = JSON.stringify(message);
  if (line.includes("\n")) {
    throw new RunnerProtocolError("A protocol line must not contain a newline.");
  }
  return `${line}\n`;
}

export function decodeMessage(line: string): ClientMessage | ServerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RunnerProtocolError("Protocol line is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RunnerProtocolError("Protocol line is not an object.");
  }

  const message = parsed as { v?: unknown; kind?: unknown };
  if (message.v !== RUNNER_PROTOCOL_VERSION) {
    // Named explicitly: the two sides are separate systemd units and an admin
    // will restart one without the other, so this is a routine mismatch that
    // deserves a routine message rather than a mysterious undefined field
    // three layers later.
    throw new RunnerProtocolError(
      `Protocol version ${String(message.v)} does not match this build's ${RUNNER_PROTOCOL_VERSION}. ` +
        "Update the control plane and the runner together.",
    );
  }
  if (typeof message.kind !== "string") {
    throw new RunnerProtocolError("Protocol line has no kind.");
  }
  return parsed as ClientMessage | ServerMessage;
}

/**
 * Turns a byte stream into whole lines.
 *
 * Stateful because a chunk boundary lands anywhere — most often in the middle
 * of a long agent message, which is exactly the case a naive split would
 * corrupt.
 */
export class LineDecoder {
  private buffer = "";

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");

    if (this.buffer.length > this.maxLineBytes) {
      // A peer streaming without newlines is either broken or hostile; either
      // way, buffering until the process dies is the worse outcome.
      this.buffer = "";
      throw new RunnerProtocolError(`A protocol line exceeded ${this.maxLineBytes} bytes.`);
    }

    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line !== "") lines.push(line);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Whatever is buffered but not yet terminated — for diagnostics only. */
  get pending(): string {
    return this.buffer;
  }
}

/** Strips what cannot cross a process boundary, leaving the wire shape. */
export function toWireContext(context: WireRunContext & { signal?: unknown }): WireRunContext {
  return {
    companyId: context.companyId,
    projectId: context.projectId,
    taskId: context.taskId,
    runId: context.runId,
    agentId: context.agentId,
    correlationId: context.correlationId,
    workspacePath: context.workspacePath,
    permissionMode: context.permissionMode,
    ...(context.redactValues ? { redactValues: context.redactValues } : {}),
  };
}
