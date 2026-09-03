import { describe, it, expect } from "vitest";
import { parsePipelineTitle, buildExecutionState } from "../hooks/useExecutionSync";
import type { SubTask } from "../../../types";

describe("parsePipelineTitle", () => {
  it("parses simple phase title", () => {
    expect(parsePipelineTitle("[pipeline:concept]")).toEqual({ phaseId: "concept" });
  });

  it("parses fan-out instance title", () => {
    expect(parsePipelineTitle("[pipeline:crawl:2]")).toEqual({ phaseId: "crawl", index: 2 });
  });

  it("ignores __input__ metadata", () => {
    expect(parsePipelineTitle("[pipeline:__input__]")).toBeNull();
  });

  it("ignores non-pipeline subtasks", () => {
    expect(parsePipelineTitle("Regular subtask")).toBeNull();
  });
});

function makeSub(title: string, status: string, agentId?: string | null, completedAt?: number | null): SubTask {
  return {
    id: Math.random().toString(),
    task_id: "task-1",
    title,
    description: null,
    status: status as SubTask["status"],
    assigned_agent_id: agentId ?? null,
    blocked_reason: null,
    cli_tool_use_id: null,
    created_at: 1000,
    completed_at: completedAt ?? null,
  };
}

describe("buildExecutionState", () => {
  it("maps simple subtasks to phase states", () => {
    const subtasks = [
      makeSub("[pipeline:__input__]", "done"),
      makeSub("[pipeline:planning]", "done", "agent-1", 2000),
      makeSub("[pipeline:crawl]", "in_progress", "agent-2"),
      makeSub("[pipeline:synthesis]", "blocked"),
    ];

    const state = buildExecutionState("task-1", subtasks);
    expect(state.taskId).toBe("task-1");
    expect(state.phases.get("planning")?.status).toBe("done");
    expect(state.phases.get("planning")?.completedAt).toBe(2000);
    expect(state.phases.get("crawl")?.status).toBe("in_progress");
    expect(state.phases.get("crawl")?.agentId).toBe("agent-2");
    expect(state.phases.get("synthesis")?.status).toBe("blocked");
    expect(state.phases.has("__input__")).toBe(false);
  });

  it("aggregates fan-out instances", () => {
    const subtasks = [
      makeSub("[pipeline:crawl]", "done"),
      makeSub("[pipeline:crawl:1]", "done"),
      makeSub("[pipeline:crawl:2]", "in_progress"),
    ];

    const state = buildExecutionState("task-1", subtasks);
    const crawl = state.phases.get("crawl")!;
    expect(crawl.totalInstances).toBe(3);
    expect(crawl.doneInstances).toBe(2);
    expect(crawl.status).toBe("in_progress");
  });

  it("marks fan-out as done when all instances complete", () => {
    const subtasks = [
      makeSub("[pipeline:crawl]", "done"),
      makeSub("[pipeline:crawl:1]", "done"),
      makeSub("[pipeline:crawl:2]", "done"),
    ];

    const state = buildExecutionState("task-1", subtasks);
    expect(state.phases.get("crawl")?.status).toBe("done");
    expect(state.phases.get("crawl")?.doneInstances).toBe(3);
  });

  it("filters subtasks by task ID", () => {
    const subtasks = [
      makeSub("[pipeline:planning]", "done"),
      { ...makeSub("[pipeline:crawl]", "in_progress"), task_id: "other-task" },
    ];

    const state = buildExecutionState("task-1", subtasks);
    expect(state.phases.has("planning")).toBe(true);
    expect(state.phases.has("crawl")).toBe(false);
  });
});
