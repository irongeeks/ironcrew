import { describe, it, expect } from "vitest";
import {
  queryTokenUsageByTask,
  queryTokenUsageByProvider,
  queryTokenUsageByAgent,
} from "../../../modules/routes/ops/token-usage.ts";

function createMockDb(rows: Record<string, unknown>[]) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  };
}

describe("queryTokenUsageByTask", () => {
  it("returns entries and aggregated totals", () => {
    const rows = [
      {
        id: 1,
        task_id: "t1",
        provider: "claude",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
      {
        id: 2,
        task_id: "t1",
        provider: "claude",
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
      },
    ];
    const result = queryTokenUsageByTask(createMockDb(rows) as any, "t1");
    expect(result.entries).toHaveLength(2);
    expect(result.totals.input_tokens).toBe(300);
    expect(result.totals.output_tokens).toBe(150);
    expect(result.totals.cache_read_tokens).toBe(30);
    expect(result.totals.cache_write_tokens).toBe(15);
  });
});

describe("queryTokenUsageByProvider", () => {
  it("returns aggregated provider rows", () => {
    const rows = [{ provider: "claude", model: "opus-4", total_input: 1000, total_output: 500, task_count: 3 }];
    const result = queryTokenUsageByProvider(createMockDb(rows) as any);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe("claude");
    expect(result.providers[0].total_input).toBe(1000);
  });
});

describe("queryTokenUsageByAgent", () => {
  it("returns tasks and totals for an agent", () => {
    const rows = [
      { task_id: "t1", provider: "claude", model: "opus-4", input_tokens: 500, output_tokens: 200, recorded_at: 1000 },
    ];
    const result = queryTokenUsageByAgent(createMockDb(rows) as any, "agent-1");
    expect(result.tasks).toHaveLength(1);
    expect(result.totals.input_tokens).toBe(500);
    expect(result.totals.output_tokens).toBe(200);
  });
});
