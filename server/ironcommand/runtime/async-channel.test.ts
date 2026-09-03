import { describe, it, expect } from "vitest";
import { AsyncEventChannel } from "./async-channel.ts";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iterable) out.push(v);
  return out;
}

describe("AsyncEventChannel", () => {
  it("delivers values pushed before iteration starts, in order", async () => {
    const ch = new AsyncEventChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.close();
    expect(await collect(ch)).toEqual([1, 2, 3]);
  });

  it("delivers values pushed after iteration has started (pull parks, then push wakes it)", async () => {
    const ch = new AsyncEventChannel<string>();
    const resultPromise = collect(ch);

    // Give the async generator a tick to start pulling and park.
    await new Promise((r) => setTimeout(r, 0));
    ch.push("a");
    ch.push("b");
    ch.close();

    expect(await resultPromise).toEqual(["a", "b"]);
  });

  it("interleaves pushes and pulls correctly under a slow consumer", async () => {
    const ch = new AsyncEventChannel<number>();
    const seen: number[] = [];

    const consumer = (async () => {
      for await (const v of ch) {
        seen.push(v);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    for (let i = 0; i < 5; i++) ch.push(i);
    ch.close();
    await consumer;

    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("ends the iterator cleanly on close() with no pending values", async () => {
    const ch = new AsyncEventChannel<number>();
    const p = collect(ch);
    await new Promise((r) => setTimeout(r, 0));
    ch.close();
    expect(await p).toEqual([]);
  });

  it("is a no-op to push after close — a late event is dropped, not thrown", async () => {
    const ch = new AsyncEventChannel<number>();
    ch.push(1);
    ch.close();
    expect(() => ch.push(2)).not.toThrow();
    expect(await collect(ch)).toEqual([1]);
  });

  it("close() is idempotent", async () => {
    const ch = new AsyncEventChannel<number>();
    ch.push(1);
    ch.close();
    expect(() => ch.close()).not.toThrow();
    expect(await collect(ch)).toEqual([1]);
  });

  it("drains every queued value before surfacing a close error", async () => {
    const ch = new AsyncEventChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.close(new Error("producer failed"));

    const out: number[] = [];
    await expect(async () => {
      for await (const v of ch) out.push(v);
    }).rejects.toThrow("producer failed");

    // Both values that were pushed before the failure were still delivered.
    expect(out).toEqual([1, 2]);
  });

  it("surfaces a close error to a puller already parked and waiting", async () => {
    const ch = new AsyncEventChannel<number>();
    const p = (async () => {
      const out: number[] = [];
      for await (const v of ch) out.push(v);
      return out;
    })();

    await new Promise((r) => setTimeout(r, 0));
    ch.close(new Error("boom"));

    await expect(p).rejects.toThrow("boom");
  });

  it("supports multiple independent producers pushing into one channel", async () => {
    const ch = new AsyncEventChannel<string>();
    const producer = async (label: string, n: number) => {
      for (let i = 0; i < n; i++) ch.push(`${label}${i}`);
    };
    await Promise.all([producer("a", 3), producer("b", 2)]);
    ch.close();
    const out = await collect(ch);
    expect(out).toHaveLength(5);
    expect(out.filter((x) => x.startsWith("a"))).toHaveLength(3);
    expect(out.filter((x) => x.startsWith("b"))).toHaveLength(2);
  });
});
