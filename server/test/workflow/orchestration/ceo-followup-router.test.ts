import { describe, it, expect, vi } from "vitest";

// Mock logger before importing code under test.
vi.mock("../../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    }),
  },
}));

import { parseFollowUpDecision } from "../../../modules/workflow/orchestration/ceo-followup-router.ts";

// ---------------------------------------------------------------------------
// parseFollowUpDecision
// ---------------------------------------------------------------------------

describe("parseFollowUpDecision", () => {
  it("parses a valid supplement decision", () => {
    const raw = JSON.stringify({
      decision: "supplement",
      target_agent_id: "agent-1",
      reasoning: "Minor fix needed",
    });
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("supplement");
    expect(result!.target_agent_id).toBe("agent-1");
    expect(result!.reasoning).toBe("Minor fix needed");
  });

  it("parses a valid pipeline_reset decision", () => {
    const raw = JSON.stringify({
      decision: "pipeline_reset",
      reset_from_phase: "design",
      reasoning: "Design phase output was wrong",
    });
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("pipeline_reset");
    expect(result!.reset_from_phase).toBe("design");
    expect(result!.reasoning).toBe("Design phase output was wrong");
  });

  it("parses a valid new_task decision", () => {
    const raw = JSON.stringify({
      decision: "new_task",
      new_task_title: "Refactor auth module",
      new_task_description: "The auth module needs a full rewrite",
      reasoning: "Completely different scope",
    });
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("new_task");
    expect(result!.new_task_title).toBe("Refactor auth module");
    expect(result!.new_task_description).toBe("The auth module needs a full rewrite");
  });

  it("parses JSON wrapped in markdown code block", () => {
    const raw = `\`\`\`json
{
  "decision": "supplement",
  "reasoning": "Just a small tweak"
}
\`\`\``;
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("supplement");
    expect(result!.reasoning).toBe("Just a small tweak");
  });

  it("returns null for invalid decision type", () => {
    const raw = JSON.stringify({
      decision: "escalate",
      reasoning: "Not a valid option",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });

  it("returns null for unparseable response", () => {
    expect(parseFollowUpDecision("This is not JSON at all")).toBeNull();
  });

  it("returns null for pipeline_reset without reset_from_phase", () => {
    const raw = JSON.stringify({
      decision: "pipeline_reset",
      reasoning: "Missing phase",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });

  it("returns null for pipeline_reset with empty reset_from_phase", () => {
    const raw = JSON.stringify({
      decision: "pipeline_reset",
      reset_from_phase: "",
      reasoning: "Empty phase",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });

  it("returns null for new_task without title", () => {
    const raw = JSON.stringify({
      decision: "new_task",
      new_task_description: "Has description but no title",
      reasoning: "Missing title",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });

  it("returns null for new_task with empty title", () => {
    const raw = JSON.stringify({
      decision: "new_task",
      new_task_title: "",
      reasoning: "Empty title",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });
});
