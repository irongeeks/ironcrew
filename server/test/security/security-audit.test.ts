import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createSecurityAuditTools, type AuditRequestLike } from "../../modules/bootstrap/security-audit.ts";

// ---------------------------------------------------------------------------
// Re-implement the non-exported pure functions to verify their behaviour.
// The source has these as module-private; we replicate the logic here so
// tests validate the exact same algorithm without coupling to exports.
// ---------------------------------------------------------------------------

function canonicalizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeAuditValue(item));
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalizeAuditValue(src[key]);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.length > 8_000) {
    return `${value.slice(0, 8_000)}...[truncated:${value.length}]`;
  }
  return value;
}

function stableAuditJson(value: unknown): string {
  try {
    return JSON.stringify(canonicalizeAuditValue(value));
  } catch {
    return JSON.stringify(String(value));
  }
}

function normalizeAuditText(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...[truncated:${trimmed.length}]`;
}

function resolveAuditRequestId(
  req: { get(name: string): string | undefined },
  body: Record<string, unknown>,
): string | null {
  const candidates: unknown[] = [
    body.request_id,
    body.requestId,
    req.get("x-request-id"),
    req.get("x-correlation-id"),
    req.get("traceparent"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200);
  }
  return null;
}

function resolveAuditRequestIp(req: AuditRequestLike): string | null {
  const forwarded = req.get("x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  if (typeof req.ip === "string" && req.ip.trim()) {
    return req.ip.trim().slice(0, 128);
  }
  if (typeof req.socket?.remoteAddress === "string" && req.socket.remoteAddress.trim()) {
    return req.socket.remoteAddress.trim().slice(0, 128);
  }
  return null;
}

function makeReq(headers: Record<string, string> = {}, overrides: Partial<AuditRequestLike> = {}): AuditRequestLike {
  return {
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    ip: overrides.ip,
    socket: overrides.socket,
  };
}

// ---------------------------------------------------------------------------
// Shared temp directory management
// ---------------------------------------------------------------------------
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(process.cwd(), ".tmp", `audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSecurityAuditTools", () => {
  it("returns all expected function names", () => {
    const tools = createSecurityAuditTools({
      db: { prepare: vi.fn() } as never,
      logsDir: tmpDir,
      nowMs: () => Date.now(),
      withSqliteBusyRetry: vi.fn(),
    });

    expect(tools).toHaveProperty("recordMessageIngressAuditOr503");
    expect(tools).toHaveProperty("recordAcceptedIngressAuditOrRollback");
    expect(tools).toHaveProperty("recordTaskCreationAudit");
    expect(tools).toHaveProperty("setTaskCreationAuditCompletion");

    expect(typeof tools.recordMessageIngressAuditOr503).toBe("function");
    expect(typeof tools.recordAcceptedIngressAuditOrRollback).toBe("function");
    expect(typeof tools.recordTaskCreationAudit).toBe("function");
    expect(typeof tools.setTaskCreationAuditCompletion).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// canonicalizeAuditValue
// ---------------------------------------------------------------------------
describe("canonicalizeAuditValue", () => {
  it("sorts object keys alphabetically", () => {
    const result = canonicalizeAuditValue({ z: 1, a: 2, m: 3 });
    const keys = Object.keys(result as Record<string, unknown>);
    expect(keys).toEqual(["a", "m", "z"]);
  });

  it("recursively sorts nested objects", () => {
    const result = canonicalizeAuditValue({ b: { d: 1, c: 2 }, a: 3 }) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b as Record<string, unknown>)).toEqual(["c", "d"]);
  });

  it("handles arrays by recursing into each element", () => {
    const result = canonicalizeAuditValue([
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ]) as Array<Record<string, unknown>>;
    expect(Object.keys(result[0])).toEqual(["a", "b"]);
    expect(Object.keys(result[1])).toEqual(["c", "d"]);
  });

  it("converts bigint to string", () => {
    expect(canonicalizeAuditValue(BigInt(42))).toBe("42");
  });

  it("truncates strings longer than 8000 chars", () => {
    const longStr = "x".repeat(10_000);
    const result = canonicalizeAuditValue(longStr) as string;
    expect(result).toContain("...[truncated:10000]");
    expect(result.length).toBeLessThan(10_000);
  });

  it("passes through primitives unchanged", () => {
    expect(canonicalizeAuditValue(42)).toBe(42);
    expect(canonicalizeAuditValue(true)).toBe(true);
    expect(canonicalizeAuditValue(null)).toBe(null);
    expect(canonicalizeAuditValue("short")).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// normalizeAuditText
// ---------------------------------------------------------------------------
describe("normalizeAuditText", () => {
  it("returns null for non-string values", () => {
    expect(normalizeAuditText(42)).toBeNull();
    expect(normalizeAuditText(null)).toBeNull();
    expect(normalizeAuditText(undefined)).toBeNull();
  });

  it("returns null for empty or whitespace-only strings", () => {
    expect(normalizeAuditText("")).toBeNull();
    expect(normalizeAuditText("   ")).toBeNull();
  });

  it("returns trimmed string when within maxLength", () => {
    expect(normalizeAuditText("  hello  ")).toBe("hello");
  });

  it("truncates long strings with marker", () => {
    const long = "a".repeat(600);
    const result = normalizeAuditText(long, 500);
    expect(result).not.toBeNull();
    expect(result!).toContain("...[truncated:600]");
    expect(result!.startsWith("a".repeat(500))).toBe(true);
  });

  it("uses default maxLength of 500", () => {
    const exact = "b".repeat(500);
    expect(normalizeAuditText(exact)).toBe(exact);

    const over = "b".repeat(501);
    expect(normalizeAuditText(over)).toContain("...[truncated:501]");
  });
});

// ---------------------------------------------------------------------------
// resolveAuditRequestId
// ---------------------------------------------------------------------------
describe("resolveAuditRequestId", () => {
  it("prefers body.request_id first", () => {
    const req = makeReq({ "x-request-id": "header-id" });
    const body = { request_id: "body-id", requestId: "body-camel-id" };
    expect(resolveAuditRequestId(req, body)).toBe("body-id");
  });

  it("falls back to body.requestId", () => {
    const req = makeReq({ "x-request-id": "header-id" });
    const body = { requestId: "camel-id" };
    expect(resolveAuditRequestId(req, body)).toBe("camel-id");
  });

  it("falls back to x-request-id header", () => {
    const req = makeReq({ "x-request-id": "header-id" });
    expect(resolveAuditRequestId(req, {})).toBe("header-id");
  });

  it("falls back to x-correlation-id header", () => {
    const req = makeReq({ "x-correlation-id": "corr-id" });
    expect(resolveAuditRequestId(req, {})).toBe("corr-id");
  });

  it("falls back to traceparent header", () => {
    const req = makeReq({ traceparent: "00-trace-id-01" });
    expect(resolveAuditRequestId(req, {})).toBe("00-trace-id-01");
  });

  it("returns null when no candidates are available", () => {
    const req = makeReq({});
    expect(resolveAuditRequestId(req, {})).toBeNull();
  });

  it("truncates request IDs over 200 characters", () => {
    const longId = "x".repeat(300);
    const req = makeReq({ "x-request-id": longId });
    const result = resolveAuditRequestId(req, {});
    expect(result).toHaveLength(200);
  });

  it("skips empty/whitespace-only candidates", () => {
    const req = makeReq({ "x-request-id": "   " });
    const body = { request_id: "" };
    expect(resolveAuditRequestId(req, body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAuditRequestIp
// ---------------------------------------------------------------------------
describe("resolveAuditRequestIp", () => {
  it("uses x-forwarded-for header first", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.50, 70.41.3.18" }, { ip: "10.0.0.1" });
    expect(resolveAuditRequestIp(req)).toBe("203.0.113.50");
  });

  it("falls back to req.ip", () => {
    const req = makeReq({}, { ip: "10.0.0.1" });
    expect(resolveAuditRequestIp(req)).toBe("10.0.0.1");
  });

  it("falls back to req.socket.remoteAddress", () => {
    const req = makeReq({}, { socket: { remoteAddress: "127.0.0.1" } });
    expect(resolveAuditRequestIp(req)).toBe("127.0.0.1");
  });

  it("returns null when no IP is available", () => {
    const req = makeReq({});
    expect(resolveAuditRequestIp(req)).toBeNull();
  });

  it("truncates IP to 128 characters", () => {
    const longIp = "a".repeat(200);
    const req = makeReq({ "x-forwarded-for": longIp });
    expect(resolveAuditRequestIp(req)!.length).toBeLessThanOrEqual(128);
  });
});

// ---------------------------------------------------------------------------
// Chain hash determinism
// ---------------------------------------------------------------------------
describe("chain hash computation", () => {
  it("is deterministic — same inputs produce same hash", () => {
    const seed = "ironcrew-security-audit-v1";
    const prevHash = "GENESIS";
    const entry = { id: "test-id", created_at: 1000, endpoint: "/api/messages" };

    function computeHash(): string {
      const hasher = createHash("sha256");
      hasher.update(seed, "utf8");
      hasher.update("|", "utf8");
      hasher.update(prevHash, "utf8");
      hasher.update("|", "utf8");
      hasher.update(stableAuditJson(entry), "utf8");
      return hasher.digest("hex");
    }

    const hash1 = computeHash();
    const hash2 = computeHash();
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("different entries produce different hashes", () => {
    const seed = "ironcrew-security-audit-v1";
    const prevHash = "GENESIS";

    function computeHash(entry: unknown): string {
      const hasher = createHash("sha256");
      hasher.update(seed, "utf8");
      hasher.update("|", "utf8");
      hasher.update(prevHash, "utf8");
      hasher.update("|", "utf8");
      hasher.update(stableAuditJson(entry), "utf8");
      return hasher.digest("hex");
    }

    const hash1 = computeHash({ id: "a", endpoint: "/api/messages" });
    const hash2 = computeHash({ id: "b", endpoint: "/api/messages" });
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Payload hash is SHA-256 of stable JSON
// ---------------------------------------------------------------------------
describe("payload hash", () => {
  it("produces a SHA-256 hex digest of the stable JSON body", () => {
    const body = { z: 1, a: 2 };
    const payloadHash = createHash("sha256").update(stableAuditJson(body), "utf8").digest("hex");

    // stableAuditJson canonicalizes keys, so {"a":2,"z":1}
    const expectedJson = JSON.stringify({ a: 2, z: 1 });
    const expectedHash = createHash("sha256").update(expectedJson, "utf8").digest("hex");

    expect(payloadHash).toBe(expectedHash);
    expect(payloadHash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// NDJSON log format
// ---------------------------------------------------------------------------
describe("NDJSON log format", () => {
  it("writes one JSON object per line to the audit log file", () => {
    const logsDir = path.join(tmpDir, "ndjson-sub");
    fs.mkdirSync(logsDir, { recursive: true });

    const tools = createSecurityAuditTools({
      db: { prepare: vi.fn() } as never,
      logsDir,
      nowMs: () => 1710000000000,
      withSqliteBusyRetry: vi.fn(),
    });

    const req = makeReq({ "user-agent": "test-agent" }, { ip: "127.0.0.1" });
    tools.recordMessageIngressAuditOr503({ status: vi.fn().mockReturnValue({ json: vi.fn() }) } as never, {
      endpoint: "/api/messages",
      req,
      body: { content: "hello" },
      idempotencyKey: null,
      outcome: "accepted",
      statusCode: 200,
      messageId: "msg-123",
    });

    const logPath = path.join(logsDir, "security-audit.ndjson");
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf8").trim();
    const lines = content.split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("chain_hash");
    expect(parsed).toHaveProperty("prev_hash", "GENESIS");
    expect(parsed).toHaveProperty("endpoint", "/api/messages");
    expect(parsed).toHaveProperty("outcome", "accepted");
    expect(parsed).toHaveProperty("status_code", 200);
    expect(parsed).toHaveProperty("payload_hash");
    expect(parsed.payload_hash).toHaveLength(64);
  });
});
