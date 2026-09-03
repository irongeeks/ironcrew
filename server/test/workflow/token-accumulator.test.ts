import { describe, it, expect } from "vitest";
import { TokenAccumulator } from "../../modules/workflow/agents/token-accumulator.ts";

function createMockDeps(budget?: { maxInput?: number; maxOutput?: number }) {
  const dbRuns: Array<Record<string, unknown>> = [];
  const logs: Array<{ kind: string; message: string }> = [];
  const broadcasts: Array<{ event: string; payload: unknown }> = [];

  return {
    deps: {
      db: {
        prepare: () => ({
          run: (...args: unknown[]) => {
            dbRuns.push({ args });
          },
        }),
      },
      appendTaskLog: (_taskId: string, kind: string, message: string) => {
        logs.push({ kind, message });
      },
      broadcast: (event: string, payload: unknown) => {
        broadcasts.push({ event, payload });
      },
      nowMs: () => 1000000,
    },
    budget: budget
      ? {
          maxInput: budget.maxInput ?? Infinity,
          maxOutput: budget.maxOutput ?? Infinity,
        }
      : null,
    dbRuns,
    logs,
    broadcasts,
  };
}

describe("TokenAccumulator", () => {
  it("records token usage to the database", () => {
    const { deps, budget, dbRuns } = createMockDeps();
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, budget);

    acc.record({ input_tokens: 100, output_tokens: 50 });

    expect(dbRuns).toHaveLength(1);
    expect(acc.totalInput).toBe(100);
    expect(acc.totalOutput).toBe(50);
  });

  it("accumulates totals across multiple records", () => {
    const { deps, budget } = createMockDeps();
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, budget);

    acc.record({ input_tokens: 100, output_tokens: 50 });
    acc.record({ input_tokens: 200, output_tokens: 100 });

    expect(acc.totalInput).toBe(300);
    expect(acc.totalOutput).toBe(150);
  });

  it("returns 'ok' when no budget is set", () => {
    const { deps } = createMockDeps();
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, null);

    const result = acc.record({ input_tokens: 999999, output_tokens: 999999 });

    expect(result).toBe("ok");
  });

  it("returns 'warning' at 80% of input budget", () => {
    const { deps, logs, broadcasts } = createMockDeps({ maxInput: 1000 });
    const budget = { maxInput: 1000, maxOutput: Infinity };
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, budget);

    const result = acc.record({ input_tokens: 800, output_tokens: 0 });

    expect(result).toBe("warning");
    expect(logs).toHaveLength(1);
    expect(logs[0].kind).toBe("token_budget_warning");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].event).toBe("token_budget_warning");
  });

  it("returns 'exceeded' at 100% of output budget", () => {
    const { deps, logs } = createMockDeps({ maxOutput: 500 });
    const budget = { maxInput: Infinity, maxOutput: 500 };
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, budget);

    const result = acc.record({ input_tokens: 0, output_tokens: 500 });

    expect(result).toBe("exceeded");
    expect(logs.some((l) => l.kind === "token_budget_exceeded")).toBe(true);
  });

  it("does not emit warning twice", () => {
    const { deps, logs } = createMockDeps();
    const budget = { maxInput: 1000, maxOutput: Infinity };
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, budget);

    acc.record({ input_tokens: 800, output_tokens: 0 });
    acc.record({ input_tokens: 50, output_tokens: 0 });

    expect(logs.filter((l) => l.kind === "token_budget_warning")).toHaveLength(1);
  });

  it("getSummary returns current totals", () => {
    const { deps } = createMockDeps();
    const acc = new TokenAccumulator("task-1", "agent-1", "claude", deps, null);

    acc.record({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 5 });

    expect(acc.getSummary()).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
    });
  });
});
