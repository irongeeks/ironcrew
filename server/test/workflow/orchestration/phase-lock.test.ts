import { describe, it, expect } from "vitest";
import { createTaskPhaseLock } from "../../../modules/workflow/orchestration/phase-lock.ts";

describe("createTaskPhaseLock", () => {
  it("serializes concurrent calls for the same taskId", async () => {
    const lock = createTaskPhaseLock();
    const order: number[] = [];

    const p1 = lock.acquire("task-1", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = lock.acquire("task-1", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("allows parallel execution for different taskIds", async () => {
    const lock = createTaskPhaseLock();
    const order: number[] = [];

    const p1 = lock.acquire("task-1", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = lock.acquire("task-2", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([2, 1]);
  });

  it("cleans up after last waiter completes", async () => {
    const lock = createTaskPhaseLock();
    await lock.acquire("task-1", async () => {});
    expect(lock.size).toBe(0);
  });
});
