import { describe, expect, it } from "vitest";
import {
  REPORT_FLOW_PREFIX,
  extractReportPathByLabel,
  isReportRequestTask,
  readReportFlowValue,
  upsertReportFlowValue,
} from "../../modules/workflow/orchestration/report-flow-helpers.ts";

describe("core report flow utilities", () => {
  it("upserts and reads report flow metadata lines", () => {
    const base = "Some task description";
    const appended = upsertReportFlowValue(base, "report_task_id", "task-123");
    expect(appended).toContain(`${REPORT_FLOW_PREFIX} report_task_id=task-123`);
    expect(readReportFlowValue(appended, "report_task_id")).toBe("task-123");

    const replaced = upsertReportFlowValue(appended, "report_task_id", "task-456");
    expect(readReportFlowValue(replaced, "report_task_id")).toBe("task-456");
  });

  it("detects documentation report request tasks", () => {
    expect(isReportRequestTask({ task_type: "documentation", description: "[REPORT REQUEST] spec" })).toBe(true);
    expect(isReportRequestTask({ task_type: "presentation", description: "[REPORT REQUEST] deck" })).toBe(false);
    expect(isReportRequestTask({ task_type: "documentation", description: "no marker" })).toBe(false);
    expect(isReportRequestTask(null)).toBe(false);
  });

  it("extracts report file paths by label", () => {
    const description = ["Markdown file: /tmp/output/report.md", "Slides file: /tmp/output/report.pptx"].join("\n");
    expect(extractReportPathByLabel(description, "Markdown file")).toBe("/tmp/output/report.md");
    expect(extractReportPathByLabel(description, "Slides file")).toBe("/tmp/output/report.pptx");
    expect(extractReportPathByLabel(description, "Missing label")).toBeNull();
  });
});
