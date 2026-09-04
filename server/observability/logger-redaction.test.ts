/**
 * A credential must never reach a log line — by construction, not by care.
 *
 * Everything the logger writes goes three places at once: stdout, the `logs`
 * table, and a WebSocket broadcast to any subscribed client. A gap audit
 * found that nothing scrubbed any of it: the run-event path had its own
 * redaction and the audit chain had `redactValue`, but the general logger had
 * none. No call site was actually leaking — which is exactly why it needed
 * fixing, because "no call site leaks today" is a property of the people who
 * wrote them, not of the code.
 *
 * These tests capture what the SQLite destination would persist, because that
 * is the copy that outlives the process.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { logger, getSqliteBuffer } from "./logger.ts";

/** Everything written since the last check, as one searchable string. */
function written(): string {
  return getSqliteBuffer()
    .map((e) => e.data)
    .join("\n");
}

let baseline = 0;
beforeEach(() => {
  baseline = getSqliteBuffer().length;
});

function sinceBaseline(): string {
  return getSqliteBuffer()
    .slice(baseline)
    .map((e) => e.data)
    .join("\n");
}

describe("the logger scrubs what call sites forget to", () => {
  it("blanks a value whose key names a secret", () => {
    logger.info({ module: "test", password: "hunter2-correct-horse", note: "ok" }, "login attempt");
    const out = sinceBaseline();
    expect(out).not.toContain("hunter2-correct-horse");
    expect(out).toContain("[REDACTED]");
    // The rest of the entry survives — a redaction that ate the log would
    // trade one problem for another.
    expect(out).toContain("login attempt");
    expect(out).toContain("ok");
  });

  it("catches a credential nested inside an error's own message", () => {
    // The realistic shape: somebody wraps a fetch that carried a header.
    const err = new Error("request failed: Authorization: Bearer sk-ant-abcdefghijklmnop0123456789");
    logger.error({ module: "test", err }, "upstream call failed");
    const out = sinceBaseline();
    expect(out).not.toContain("sk-ant-abcdefghijklmnop0123456789");
    expect(out).toContain("upstream call failed");
  });

  it("catches one interpolated into the message itself", () => {
    // `formatters.log` never sees the message string; the logMethod hook does.
    logger.warn({ module: "test" }, "token=sk-ant-abcdefghijklmnop0123456789 rejected");
    expect(sinceBaseline()).not.toContain("sk-ant-abcdefghijklmnop0123456789");
  });

  it("reaches a credential buried deep in a config object", () => {
    logger.info(
      {
        module: "test",
        config: { servers: [{ name: "mcp", env: { API_TOKEN: "sk-ant-abcdefghijklmnop0123456789" } }] },
      },
      "starting servers",
    );
    expect(sinceBaseline()).not.toContain("sk-ant-abcdefghijklmnop0123456789");
  });

  it("leaves an ordinary log untouched", () => {
    logger.info({ module: "test", taskId: "task_123", count: 7 }, "queue drained");
    const out = sinceBaseline();
    expect(out).toContain("task_123");
    expect(out).toContain("queue drained");
    expect(out).not.toContain("[REDACTED]");
  });

  it("survives a circular object rather than throwing inside the logger", () => {
    // A logger that can crash the thing it is observing is worse than none.
    const circular: Record<string, unknown> = { module: "test", name: "loop" };
    circular.self = circular;
    expect(() => logger.info(circular, "circular")).not.toThrow();
    expect(sinceBaseline()).toContain("circular");
  });
});
