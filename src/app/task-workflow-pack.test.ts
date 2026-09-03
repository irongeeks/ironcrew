import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { applyOfficePackToTaskInput, filterTasksByOfficePack } from "./task-workflow-pack";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    description: null,
    department_id: null,
    assigned_agent_id: null,
    status: "inbox",
    priority: 3,
    task_type: "general",
    project_path: null,
    result: null,
    started_at: null,
    completed_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("task workflow pack routing", () => {
  it("활성 오피스팩에 맞는 업무만 필터링한다", () => {
    const tasks = [
      makeTask({ id: "dev-default" }),
      makeTask({ id: "dev-explicit", workflow_pack_key: "development" }),
      makeTask({ id: "web-research", workflow_pack_key: "web_research_report" }),
    ];

    expect(filterTasksByOfficePack(tasks, "development").map((task) => task.id)).toEqual([
      "dev-default",
      "dev-explicit",
    ]);
    expect(filterTasksByOfficePack(tasks, "web_research_report").map((task) => task.id)).toEqual(["web-research"]);
  });

  it("업무 생성 입력값에 활성 오피스팩을 강제로 주입한다", () => {
    const input = {
      title: "Pack task",
      description: "desc",
      workflow_pack_key: "novel" as const,
      project_id: "project-1",
    };

    expect(applyOfficePackToTaskInput(input, "video_preprod")).toEqual({
      title: "Pack task",
      description: "desc",
      workflow_pack_key: "video_preprod",
      project_id: "project-1",
    });
  });
});
