import { describe, expect, it } from "vitest";
import { createAutoUpdateLock } from "./update-auto-lock.ts";

describe("auto update lock", () => {
  it("allows only one holder at a time", () => {
    const lock = createAutoUpdateLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isHeld()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
  });

  it("release is idempotent", () => {
    const lock = createAutoUpdateLock();
    lock.release();
    expect(lock.isHeld()).toBe(false);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
    lock.release();
    expect(lock.isHeld()).toBe(false);
  });
});
