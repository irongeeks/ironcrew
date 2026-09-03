import { describe, it, expect, vi } from "vitest";
import type { NodeExecuteContext, NodeConnectorRegistry, NodeDatabase } from "../../node-types/node-type-interface.ts";
import ComfyuiGenerateNode from "../../node-types/built-in/comfyui-generate/index.ts";
import PlanningMeetingNode from "../../node-types/built-in/planning-meeting/index.ts";
import CrossDeptNode from "../../node-types/built-in/cross-dept/index.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeDb(overrides: Partial<NodeDatabase> = {}): NodeDatabase {
  return {
    run: vi.fn(),
    get: vi.fn(() => undefined),
    all: vi.fn(() => []),
    ...overrides,
  };
}

function makeConnectorRegistry(overrides: Partial<NodeConnectorRegistry> = {}): NodeConnectorRegistry {
  return {
    executeCapability: vi.fn(async () => ({
      status: "success" as const,
      artifacts: [{ path: "/out/image.png", type: "image" }],
      costInfo: { durationMs: 1200 },
    })),
    hasBinding: vi.fn(() => true),
    getAgentGuidance: vi.fn(() => "some guidance"),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<NodeExecuteContext> = {}): NodeExecuteContext {
  return {
    taskId: "task-1",
    phaseId: "phase-1",
    inputs: {},
    config: {},
    db: makeDb(),
    lang: "en",
    ...overrides,
  };
}

// ── ComfyUI Generate ────────────────────────────────────────────────────────

describe("ComfyuiGenerateNode", () => {
  it("has correct metadata", () => {
    expect(ComfyuiGenerateNode.key).toBe("comfyui_generate");
    expect(ComfyuiGenerateNode.meta.category).toBe("connector");
  });

  it("returns error when no connector registry is available", async () => {
    const ctx = makeCtx({ inputs: { prompt: "a cat" }, config: { capability: "text2img" } });
    const result = await ComfyuiGenerateNode.execute(ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("No connector registry");
  });

  it("returns error when capability has no binding", async () => {
    const registry = makeConnectorRegistry({ hasBinding: vi.fn(() => false) });
    const ctx = makeCtx({
      inputs: { prompt: "a cat" },
      config: { capability: "text2img" },
      connectorRegistry: registry,
    });
    const result = await ComfyuiGenerateNode.execute(ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("No binding configured");
  });

  it("successfully generates via connector (text2img)", async () => {
    const registry = makeConnectorRegistry();
    const ctx = makeCtx({
      inputs: { prompt: "a cat", negative_prompt: "dog" },
      config: { capability: "text2img", width: 512, height: 512 },
      connectorRegistry: registry,
    });
    const result = await ComfyuiGenerateNode.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.outputs.primary_path).toBe("/out/image.png");
    expect(result.outputs.artifacts).toHaveLength(1);
    expect(registry.executeCapability).toHaveBeenCalledWith("text2img", expect.objectContaining({ prompt: "a cat" }));
  });

  it("maps prompt→text for text2speech capability", async () => {
    const registry = makeConnectorRegistry({
      executeCapability: vi.fn(async () => ({
        status: "success" as const,
        artifacts: [{ path: "/out/speech.wav", type: "audio" }],
      })),
    });
    const ctx = makeCtx({
      inputs: { prompt: "Hello world", language: "English (en)", exaggeration: 0.8 },
      config: { capability: "text2speech" },
      connectorRegistry: registry,
    });
    const result = await ComfyuiGenerateNode.execute(ctx);
    expect(result.status).toBe("success");
    // Must send `text` not `prompt` to the connector
    expect(registry.executeCapability).toHaveBeenCalledWith(
      "text2speech",
      expect.objectContaining({ text: "Hello world", language: "English (en)", exaggeration: 0.8 }),
    );
    // Must NOT have `prompt` key in the connector input
    const callArgs = (registry.executeCapability as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(callArgs).not.toHaveProperty("prompt");
  });

  it("forwards connector error", async () => {
    const registry = makeConnectorRegistry({
      executeCapability: vi.fn(async () => ({
        status: "error" as const,
        artifacts: [],
        error: "GPU out of memory",
      })),
    });
    const ctx = makeCtx({
      inputs: { prompt: "a cat" },
      config: { capability: "text2img" },
      connectorRegistry: registry,
    });
    const result = await ComfyuiGenerateNode.execute(ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("GPU out of memory");
  });

  it("provides agent guidance", () => {
    const registry = makeConnectorRegistry();
    const ctx = makeCtx({ config: { capability: "img2video" }, connectorRegistry: registry });
    const guidance = ComfyuiGenerateNode.getAgentGuidance!(ctx, "en");
    expect(guidance).toBe("some guidance");
    expect(registry.getAgentGuidance).toHaveBeenCalledWith("img2video", "en");
  });
});

// ── Planning Meeting ────────────────────────────────────────────────────────

describe("PlanningMeetingNode", () => {
  it("has correct metadata", () => {
    expect(PlanningMeetingNode.key).toBe("planning_meeting");
    expect(PlanningMeetingNode.meta.category).toBe("collaboration");
  });

  it("creates a default plan item when no notes are provided", async () => {
    const db = makeDb({
      all: vi.fn(() => [
        { id: "dev", name: "Development" },
        { id: "design", name: "Design" },
      ]),
    });
    const ctx = makeCtx({
      inputs: { task_brief: "Build a landing page" },
      db,
    });
    const result = await PlanningMeetingNode.execute(ctx);
    expect(result.status).toBe("success");
    const plan = result.outputs.plan as { items: unknown[] };
    expect(plan.items).toHaveLength(1);
    expect(result.outputs.summary).toContain("Build a landing page");
  });

  it("extracts action items from planning notes", async () => {
    const db = makeDb({
      all: vi.fn(() => [
        { id: "dev", name: "Development" },
        { id: "design", name: "Design" },
        { id: "qa", name: "QA" },
      ]),
      get: vi.fn((sql: string, ...params: unknown[]) => {
        if (typeof sql === "string" && sql.includes("team_leader")) {
          return { id: `leader-${params[0]}` };
        }
        return undefined;
      }),
    });
    const ctx = makeCtx({
      inputs: {
        task_brief: "Build a landing page",
        planning_notes: [
          "Implement the hero section with React components",
          "Create UI mockups in Figma",
          "Write test cases for form validation",
        ],
        department_scope: "dev",
      },
      db,
    });
    const result = await PlanningMeetingNode.execute(ctx);
    expect(result.status).toBe("success");
    const plan = result.outputs.plan as { items: Array<{ title: string; is_cross_dept: boolean }> };
    expect(plan.items).toHaveLength(3);
    expect(result.outputs.department_ids).toBeInstanceOf(Array);
  });

  it("deduplicates notes", async () => {
    const db = makeDb({ all: vi.fn(() => []) });
    const ctx = makeCtx({
      inputs: {
        task_brief: "Test",
        planning_notes: ["Same note", "Same note", "SAME NOTE"],
      },
      db,
    });
    const result = await PlanningMeetingNode.execute(ctx);
    const plan = result.outputs.plan as { items: unknown[] };
    expect(plan.items).toHaveLength(1);
  });

  it("returns awaiting_approval with outputs preserved", async () => {
    const db = makeDb({
      all: vi.fn(() => [{ id: "dev", name: "Development" }]),
    });
    const ctx = makeCtx({
      inputs: { task_brief: "Test task", planning_notes: ["Do something"] },
      config: { require_approval: true },
      db,
    });
    const result = await PlanningMeetingNode.execute(ctx);
    expect(result.status).toBe("awaiting_approval");
    // Outputs must still be populated so the graph-runner can persist them
    const plan = result.outputs.plan as { items: unknown[] };
    expect(plan.items.length).toBeGreaterThan(0);
    expect(result.outputs.summary).toBeTruthy();
    expect(result.outputs.department_ids).toBeInstanceOf(Array);
  });
});

// ── Cross-Dept Handoff ──────────────────────────────────────────────────────

describe("CrossDeptNode", () => {
  it("has correct metadata", () => {
    expect(CrossDeptNode.key).toBe("cross_dept");
    expect(CrossDeptNode.meta.category).toBe("collaboration");
  });

  it("returns error when plan has no items", async () => {
    const ctx = makeCtx({ inputs: { plan: { not_items: [] } } });
    const result = await CrossDeptNode.execute(ctx);
    expect(result.status).toBe("error");
    expect(result.error).toContain("items");
  });

  it("creates handoffs for cross-department items", async () => {
    const db = makeDb({
      get: vi.fn((sql: string, ...params: unknown[]) => {
        if (typeof sql === "string" && sql.includes("departments")) {
          return { id: params[0], name: `Dept ${params[0]}` };
        }
        if (typeof sql === "string" && sql.includes("agents")) {
          return { id: `leader-${params[0]}`, name: `Leader of ${params[0]}` };
        }
        return undefined;
      }),
    });
    const plan = {
      items: [
        { title: "Internal task", description: "Stays in source", department_id: "dev", is_cross_dept: false },
        { title: "Design work", description: "Goes to design", department_id: "design", is_cross_dept: true },
        { title: "QA review", description: "Goes to QA", department_id: "qa", is_cross_dept: true },
        { title: "More design", description: "Also design", department_id: "design", is_cross_dept: true },
      ],
    };
    const ctx = makeCtx({
      inputs: { plan },
      config: { source_department: "dev" },
      db,
    });
    const result = await CrossDeptNode.execute(ctx);
    expect(result.status).toBe("success");
    const handoffs = result.outputs.handoffs as Array<{ department_id: string; items: unknown[] }>;
    expect(handoffs).toHaveLength(2); // design + qa
    const designHandoff = handoffs.find((h) => h.department_id === "design");
    expect(designHandoff!.items).toHaveLength(2);
    expect(result.outputs.handoff_count).toBe(2);
  });

  it("returns empty handoffs when all items are internal", async () => {
    const plan = {
      items: [
        { title: "Task A", description: "Internal", department_id: "dev" },
        { title: "Task B", description: "Also internal", department_id: "dev" },
      ],
    };
    const ctx = makeCtx({
      inputs: { plan },
      config: { source_department: "dev" },
    });
    const result = await CrossDeptNode.execute(ctx);
    expect(result.status).toBe("success");
    expect(result.outputs.handoff_count).toBe(0);
    expect(result.outputs.summary).toContain("No cross-department handoffs");
  });

  it("returns awaiting_approval with outputs preserved", async () => {
    const plan = {
      items: [{ title: "X", description: "Y", department_id: "design" }],
    };
    const ctx = makeCtx({
      inputs: { plan },
      config: { source_department: "dev", require_approval: true },
      db: makeDb({
        get: vi.fn(() => ({ id: "dept-1", name: "Design" })),
      }),
    });
    const result = await CrossDeptNode.execute(ctx);
    expect(result.status).toBe("awaiting_approval");
    // Outputs must still be populated so the graph-runner can persist them
    const handoffs = result.outputs.handoffs as unknown[];
    expect(handoffs.length).toBeGreaterThan(0);
    expect(result.outputs.summary).toBeTruthy();
    expect(result.outputs.handoff_count).toBe(1);
  });
});
