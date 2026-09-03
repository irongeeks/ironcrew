import { beforeEach, describe, expect, it } from "vitest";

import { isLoginLockedOut, recordLoginFailure, resetLoginFailures } from "../../security/rate-limit.ts";

describe("login IP lockout", () => {
  const ip = "203.0.113.42";

  beforeEach(() => {
    resetLoginFailures(ip);
  });

  it("returns false for a fresh IP with no failures", () => {
    expect(isLoginLockedOut(ip)).toBe(false);
  });

  it("returns false after fewer than 10 failures", () => {
    for (let i = 0; i < 9; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginLockedOut(ip)).toBe(false);
  });

  it("locks out the IP after 10 failures", () => {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginLockedOut(ip)).toBe(true);
  });

  it("remains locked out after additional failures beyond threshold", () => {
    for (let i = 0; i < 15; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginLockedOut(ip)).toBe(true);
  });

  it("resetLoginFailures clears the lockout", () => {
    for (let i = 0; i < 10; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginLockedOut(ip)).toBe(true);
    resetLoginFailures(ip);
    expect(isLoginLockedOut(ip)).toBe(false);
  });

  it("treats different IPs independently", () => {
    const ip2 = "198.51.100.7";
    resetLoginFailures(ip2);
    for (let i = 0; i < 10; i++) {
      recordLoginFailure(ip);
    }
    expect(isLoginLockedOut(ip)).toBe(true);
    expect(isLoginLockedOut(ip2)).toBe(false);
    resetLoginFailures(ip2);
  });
});
