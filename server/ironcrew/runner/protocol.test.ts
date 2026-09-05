import { describe, it, expect } from "vitest";
import {
  decodeMessage,
  decodeClientMessage,
  encodeMessage,
  LineDecoder,
  RunnerProtocolError,
  RUNNER_PROTOCOL_VERSION,
  toWireContext,
} from "./protocol.ts";

describe("encoding", () => {
  it("puts one message on one line", () => {
    const line = encodeMessage({ v: RUNNER_PROTOCOL_VERSION, kind: "hello", token: "geheim" });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  it("survives a payload full of newlines", () => {
    const event = { text: "Zeile eins\nZeile zwei\r\nZeile drei" };
    const line = encodeMessage({
      v: RUNNER_PROTOCOL_VERSION,
      kind: "event",
      id: "1",
      event: event as never,
    });

    // A JSON string escapes newlines, so a line boundary stays unambiguous
    // even when an agent's output is full of them.
    expect(line.trimEnd().includes("\n")).toBe(false);
    const decoded = decodeMessage(line.trimEnd()) as unknown as { event: { text: string } };
    expect(decoded.event.text).toBe(event.text);
  });
});

describe("decoding", () => {
  it("validates authenticated run ingress and never echoes rejected secret fields", () => {
    const malformed = JSON.stringify({
      v: RUNNER_PROTOCOL_VERSION,
      kind: "start",
      id: "request",
      runtimeType: "claude",
      input: { prompt: "x", apiKey: "private-value" },
      context: {},
    });
    expect(() => decodeClientMessage(malformed)).toThrow("Invalid runner request shape.");
    try {
      decodeClientMessage(malformed);
    } catch (err) {
      expect(String(err)).not.toContain("private-value");
    }
    expect(() =>
      decodeClientMessage(JSON.stringify({ v: RUNNER_PROTOCOL_VERSION, kind: "not-real", id: "a" })),
    ).toThrow();
  });
  it("rejects what is not JSON", () => {
    expect(() => decodeMessage("nicht json")).toThrow(RunnerProtocolError);
    expect(() => decodeMessage("")).toThrow(RunnerProtocolError);
  });

  it("rejects a JSON value that is not an object", () => {
    expect(() => decodeMessage("42")).toThrow(RunnerProtocolError);
    expect(() => decodeMessage("null")).toThrow(RunnerProtocolError);
    expect(() => decodeMessage('"text"')).toThrow(RunnerProtocolError);
  });

  it("names a version mismatch as what it is", () => {
    // The two sides are separate systemd units; an admin restarting one and
    // not the other is routine, and deserves a routine message rather than a
    // mysteriously undefined field three layers later.
    const line = JSON.stringify({ v: 99, kind: "hello", token: "x" });
    expect(() => decodeMessage(line)).toThrow(/version 99/);
    expect(() => decodeMessage(line)).toThrow(/together/);
  });

  it("rejects a message with no kind", () => {
    expect(() => decodeMessage(JSON.stringify({ v: RUNNER_PROTOCOL_VERSION }))).toThrow(/kind/);
  });

  it("round-trips every message shape", () => {
    const messages = [
      { v: RUNNER_PROTOCOL_VERSION, kind: "hello", token: "t" },
      { v: RUNNER_PROTOCOL_VERSION, kind: "start", id: "1", runtimeType: "claude", input: {}, context: {} },
      { v: RUNNER_PROTOCOL_VERSION, kind: "cancel", id: "1", runId: "run_1" },
      { v: RUNNER_PROTOCOL_VERSION, kind: "end", id: "1" },
      { v: RUNNER_PROTOCOL_VERSION, kind: "error", id: "1", message: "kaputt" },
    ];
    for (const message of messages) {
      expect(decodeMessage(encodeMessage(message as never).trimEnd())).toEqual(message);
    }
  });
});

describe("LineDecoder", () => {
  it("reassembles a message split across chunks", () => {
    const decoder = new LineDecoder();
    // The common case: a chunk boundary lands inside a long agent message,
    // which a naive split would corrupt.
    expect(decoder.push('{"v":1,"kind":"he')).toEqual([]);
    expect(decoder.push('llo","token":"x"}\n')).toEqual(['{"v":1,"kind":"hello","token":"x"}']);
  });

  it("returns several messages arriving in one chunk", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("keeps a trailing partial line for the next chunk", () => {
    const decoder = new LineDecoder();
    expect(decoder.push("a\nb")).toEqual(["a"]);
    expect(decoder.pending).toBe("b");
    expect(decoder.push("c\n")).toEqual(["bc"]);
  });

  it("ignores blank lines rather than emitting empty messages", () => {
    expect(new LineDecoder().push("\n\na\n\n")).toEqual(["a"]);
  });

  it("accepts a Buffer as well as a string", () => {
    expect(new LineDecoder().push(Buffer.from("hallo\n"))).toEqual(["hallo"]);
  });

  it("refuses to buffer forever when a peer never sends a newline", () => {
    const decoder = new LineDecoder(64);
    // Broken or hostile, it does not matter which: buffering until the
    // process dies is the worse outcome either way.
    expect(() => decoder.push("x".repeat(100))).toThrow(/exceeded/);
    // And it recovers rather than staying poisoned.
    expect(decoder.push("a\n")).toEqual(["a"]);
  });
});

describe("toWireContext", () => {
  it("retains deny-all restrictions and rejects attempts to send relaxed hard guards", () => {
    const ctx = {
      companyId: "cmp",
      projectId: null,
      taskId: "task",
      runId: "run",
      agentId: "agent",
      correlationId: "corr",
      workspacePath: "",
      permissionMode: "restricted" as const,
      vendorRestrictions: { allowedFamilies: [], allowedProviders: [] },
    };
    const message = {
      v: RUNNER_PROTOCOL_VERSION,
      kind: "start",
      id: "request",
      runtimeType: "openrouter",
      input: { prompt: "x" },
      context: toWireContext(ctx),
    };
    expect(decodeClientMessage(JSON.stringify(message))).toEqual(message);
    message.context.vendorRestrictions = {
      ...ctx.vendorRestrictions,
      telemetry: true,
    } as typeof ctx.vendorRestrictions;
    expect(() => decodeClientMessage(JSON.stringify(message))).toThrow("Invalid runner request shape");
  });

  const context = {
    companyId: "cmp_1",
    projectId: null,
    taskId: "task_1",
    runId: "run_1",
    agentId: "agt_1",
    correlationId: "corr_1",
    workspacePath: "/srv/ws",
    permissionMode: "restricted" as const,
    signal: new AbortController().signal,
  };

  it("drops what cannot cross a process boundary", () => {
    const wire = toWireContext(context);
    // Cancellation crosses as its own message; a serialised signal would be
    // an object that silently never fires.
    expect("signal" in wire).toBe(false);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });

  it("keeps every field an event needs to be attributable", () => {
    const wire = toWireContext(context);
    // An event that cannot be attributed to a company, task, run and
    // correlation id cannot be audited.
    for (const key of ["companyId", "taskId", "runId", "correlationId", "workspacePath", "permissionMode"]) {
      expect(wire).toHaveProperty(key);
    }
  });

  it("carries redaction values only when there are some", () => {
    expect("redactValues" in toWireContext(context)).toBe(false);
    expect(toWireContext({ ...context, redactValues: ["geheim"] }).redactValues).toEqual(["geheim"]);
  });
});
