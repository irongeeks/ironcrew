import { describe, it, expect } from "vitest";
import { isBlockedSsrfTarget } from "../../security/ssrf.ts";

describe("isBlockedSsrfTarget", () => {
  it("blocks cloud metadata endpoint", () => {
    expect(isBlockedSsrfTarget("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });
  it("blocks Google metadata", () => {
    expect(isBlockedSsrfTarget("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
  });
  it("blocks localhost", () => {
    expect(isBlockedSsrfTarget("http://localhost:8080/")).toBe(true);
  });
  it("blocks 127.x.x.x", () => {
    expect(isBlockedSsrfTarget("http://127.0.0.1:3000/api")).toBe(true);
  });
  it("blocks ::1", () => {
    expect(isBlockedSsrfTarget("http://[::1]:8080/")).toBe(true);
  });
  it("blocks RFC 1918 10.x", () => {
    expect(isBlockedSsrfTarget("http://10.0.0.1/")).toBe(true);
  });
  it("blocks RFC 1918 172.16-31.x", () => {
    expect(isBlockedSsrfTarget("http://172.16.0.1/")).toBe(true);
  });
  it("blocks RFC 1918 192.168.x", () => {
    expect(isBlockedSsrfTarget("http://192.168.1.1/")).toBe(true);
  });
  it("blocks link-local", () => {
    expect(isBlockedSsrfTarget("http://169.254.42.42/")).toBe(true);
  });
  it("blocks IPv6-mapped IPv4", () => {
    expect(isBlockedSsrfTarget("http://[::ffff:10.0.0.1]/")).toBe(true);
  });
  it("allows public IPs", () => {
    expect(isBlockedSsrfTarget("https://api.openai.com/v1")).toBe(false);
  });
  it("allows public IPs by number", () => {
    expect(isBlockedSsrfTarget("http://8.8.8.8/")).toBe(false);
  });
  it("blocks invalid URLs", () => {
    expect(isBlockedSsrfTarget("not-a-url")).toBe(true);
  });
  it("does not block 172.15.x (outside 172.16-31 range)", () => {
    expect(isBlockedSsrfTarget("http://172.15.0.1/")).toBe(false);
  });
  it("blocks 0.0.0.0", () => {
    expect(isBlockedSsrfTarget("http://0.0.0.0:8080/")).toBe(true);
  });
  it("blocks IPv6 unique-local (fc00::/7)", () => {
    expect(isBlockedSsrfTarget("http://[fd12::1]/")).toBe(true);
  });
  it("blocks IPv6 link-local (fe80::/10)", () => {
    expect(isBlockedSsrfTarget("http://[fe80::1]/")).toBe(true);
  });

  describe("allowLocal mode", () => {
    const local = { allowLocal: true };
    it("still blocks cloud metadata", () => {
      expect(isBlockedSsrfTarget("http://169.254.169.254/latest/", local)).toBe(true);
      expect(isBlockedSsrfTarget("http://metadata.google.internal/", local)).toBe(true);
    });
    it("allows localhost", () => {
      expect(isBlockedSsrfTarget("http://localhost:8188/", local)).toBe(false);
      expect(isBlockedSsrfTarget("http://127.0.0.1:11434/", local)).toBe(false);
    });
    it("allows RFC 1918 addresses", () => {
      expect(isBlockedSsrfTarget("http://10.0.0.5:8188/", local)).toBe(false);
      expect(isBlockedSsrfTarget("http://192.168.1.100:3000/", local)).toBe(false);
    });
    it("allows public IPs", () => {
      expect(isBlockedSsrfTarget("https://api.openai.com/v1", local)).toBe(false);
    });
  });
});
