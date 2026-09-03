import { describe, it, expect } from "vitest";
import { createTaskPhaseLock } from "../../../modules/workflow/orchestration/phase-lock.ts";

describe("phase-lock concurrency", () => {
  it("serializes concurrent calls for the same taskId", async () => {
    const lock = createTaskPhaseLock();
    const order: string[] = [];

    const p1 = lock.acquire("task-1", async () => {
      order.push("p1-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("p1-end");
    });

    const p2 = lock.acquire("task-1", async () => {
      order.push("p2-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("p2-end");
    });

    await Promise.all([p1, p2]);

    // p1 must fully complete before p2 starts
    expect(order).toEqual(["p1-start", "p1-end", "p2-start", "p2-end"]);
  });

  it("allows parallel execution for different taskIds", async () => {
    const lock = createTaskPhaseLock();
    const order: string[] = [];

    const pA = lock.acquire("task-a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });

    const pB = lock.acquire("task-b", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-end");
    });

    await Promise.all([pA, pB]);

    // b should finish before a because they run in parallel and b's delay is shorter
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
    expect(order.indexOf("b-end")).toBeLessThan(order.indexOf("a-end"));
  });

  it("releases lock even when callback throws", async () => {
    const lock = createTaskPhaseLock();
    const order: string[] = [];

    const p1 = lock.acquire("task-1", async () => {
      order.push("p1-start");
      throw new Error("boom");
    });

    await p1.catch(() => {
      // swallow the error
    });

    // Lock should be released — a subsequent acquire must succeed without hanging
    await lock.acquire("task-1", async () => {
      order.push("p2-done");
    });

    expect(order).toEqual(["p1-start", "p2-done"]);
    expect(lock.size).toBe(0);
  });
});
