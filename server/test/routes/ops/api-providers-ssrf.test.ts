import { describe, it, expect } from "vitest";
import { isBlockedSsrfTarget } from "../../../security/ssrf.ts";

describe("isBlockedSsrfTarget", () => {
  it("blocks cloud metadata endpoint 169.254.169.254", () => {
    expect(isBlockedSsrfTarget("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("blocks Google metadata endpoint", () => {
    expect(isBlockedSsrfTarget("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
  });

  it("blocks link-local addresses (169.254.x.x)", () => {
    expect(isBlockedSsrfTarget("http://169.254.1.1/foo")).toBe(true);
    expect(isBlockedSsrfTarget("http://169.254.100.200:8080/bar")).toBe(true);
  });

  it("blocks RFC 1918 10.x.x.x", () => {
    expect(isBlockedSsrfTarget("http://10.0.0.1/v1/models")).toBe(true);
    expect(isBlockedSsrfTarget("http://10.255.255.255:9090/")).toBe(true);
  });

  it("blocks RFC 1918 172.16-31.x.x", () => {
    expect(isBlockedSsrfTarget("http://172.16.0.1/api")).toBe(true);
    expect(isBlockedSsrfTarget("http://172.31.255.255/")).toBe(true);
  });

  it("does not block 172.15.x.x or 172.32.x.x", () => {
    expect(isBlockedSsrfTarget("http://172.15.0.1/api")).toBe(false);
    expect(isBlockedSsrfTarget("http://172.32.0.1/api")).toBe(false);
  });

  it("blocks RFC 1918 192.168.x.x", () => {
    expect(isBlockedSsrfTarget("http://192.168.1.1/")).toBe(true);
    expect(isBlockedSsrfTarget("http://192.168.0.100:3000/v1")).toBe(true);
  });

  it("allows legitimate public API URLs", () => {
    expect(isBlockedSsrfTarget("https://api.openai.com/v1/models")).toBe(false);
    expect(isBlockedSsrfTarget("https://api.anthropic.com/v1/models")).toBe(false);
    expect(isBlockedSsrfTarget("https://generativelanguage.googleapis.com/v1beta/models")).toBe(false);
    expect(isBlockedSsrfTarget("https://api.together.xyz/v1/models")).toBe(false);
  });

  it("blocks loopback addresses (ollama exemption is at call site, not here)", () => {
    expect(isBlockedSsrfTarget("http://localhost:11434/v1/models")).toBe(true);
    expect(isBlockedSsrfTarget("http://127.0.0.1:11434/v1/models")).toBe(true);
    expect(isBlockedSsrfTarget("http://127.255.255.255:8080/api")).toBe(true);
    expect(isBlockedSsrfTarget("http://[::1]:8790/api/tasks")).toBe(true);
  });

  it("blocks malformed URLs", () => {
    expect(isBlockedSsrfTarget("not-a-url")).toBe(true);
    expect(isBlockedSsrfTarget("")).toBe(true);
  });
});
