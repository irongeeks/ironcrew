import { describe, it, expect, vi } from "vitest";
import { updateWorkflowMeta } from "../../../modules/workflow/orchestration/pipeline-helpers.ts";

describe("updateWorkflowMeta — transaction safety", () => {
  it("wraps read-modify-write in a SAVEPOINT", () => {
    const execCalls: string[] = [];
    const mockDb = {
      exec: vi.fn((sql: string) => {
        execCalls.push(sql);
      }),
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT")) {
          return {
            get: () => ({ workflow_meta_json: JSON.stringify({ existing: true }) }),
          };
        }
        return { run: vi.fn() };
      }),
    };

    updateWorkflowMeta(mockDb as any, "task-1", { newField: "value" }, Date.now());

    expect(execCalls).toContain("SAVEPOINT meta_update");
    expect(execCalls).toContain("RELEASE meta_update");
    const beginIdx = execCalls.indexOf("SAVEPOINT meta_update");
    const releaseIdx = execCalls.indexOf("RELEASE meta_update");
    expect(beginIdx).toBeLessThan(releaseIdx);
  });
});
