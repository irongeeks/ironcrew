import { describe, expect, it } from "vitest";
import {
  assertNoUnresolvedDeferredRuntimeFunctions,
  assertRuntimeFunctionsResolved,
  createDeferredRuntimeProxy,
} from "../modules/deferred-runtime.ts";

describe("deferred runtime wiring", () => {
  it("retains late binding when a helper captured before initialization is called", () => {
    const runtime: { run?: (id: string, count: number) => string } = {};
    const proxy = createDeferredRuntimeProxy(runtime);
    const deferred = proxy.run;
    expect(deferred).toBeTypeOf("function");
    expect(() => deferred?.("task", 2)).toThrow("run_not_initialized");
    expect(() => assertNoUnresolvedDeferredRuntimeFunctions(runtime)).toThrow("run");

    runtime.run = (id, count) => `${id}:${count}`;
    expect(deferred?.("task", 2)).toBe("task:2");
    runtime.run = (id, count) => `${id}:${count + 1}`;
    expect(deferred?.("task", 2)).toBe("task:3");
    expect(() => assertRuntimeFunctionsResolved(runtime, ["run"])).not.toThrow();
    expect(() => assertNoUnresolvedDeferredRuntimeFunctions(runtime)).not.toThrow();
  });

  it("preserves existing values and reports missing or unresolved helpers", () => {
    const metadata = Symbol("metadata");
    const runtime: { value: number; pending?: () => void; [metadata]: string } = {
      value: 7,
      [metadata]: "ready",
    };
    const proxy = createDeferredRuntimeProxy(runtime);
    expect(proxy.value).toBe(7);
    expect(proxy[metadata]).toBe("ready");
    expect(proxy.pending).toBeTypeOf("function");
    expect(() => assertRuntimeFunctionsResolved(runtime, ["absent", "pending"])).toThrow(
      "missing: absent | unresolved: pending",
    );
    expect(() =>
      assertNoUnresolvedDeferredRuntimeFunctions(runtime, "optional wiring", { ignoreNames: ["pending"] }),
    ).not.toThrow();
  });
});
