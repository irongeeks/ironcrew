import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Mock llm-call module to control provider resolution and LLM responses.
const mockCallLlm = vi.fn();
const mockGetFirstEnabledProvider = vi.fn();
const mockResolveModel = vi.fn();

vi.mock("../../../modules/workflow/orchestration/llm-call.ts", () => ({
  callLlm: (...args: unknown[]) => mockCallLlm(...args),
  getFirstEnabledProvider: (...args: unknown[]) => mockGetFirstEnabledProvider(...args),
  resolveModel: (...args: unknown[]) => mockResolveModel(...args),
}));

import {
  routeFollowUpViaCeo,
  parseFollowUpDecision,
} from "../../../modules/workflow/orchestration/ceo-followup-router.ts";

// ---------------------------------------------------------------------------
// Mock DB factory for routeFollowUpViaCeo
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  title: string;
  description: string | null;
  department_id: string | null;
  assigned_agent_id: string | null;
  status: string;
  workflow_pack_key: string;
}

interface MockReview {
  normalized_note: string;
  raw_note: string;
  first_round: number;
  created_at: number;
}

interface MockAgent {
  id: string;
  name: string;
  role: string;
  department_id: string | null;
  dept_name: string | null;
  cli_provider: string | null;
  status: string;
}

interface MockSubtask {
  id: string;
  title: string;
  status: string;
}

function createMockDb(opts: {
  tasks?: MockTask[];
  reviews?: MockReview[];
  agents?: MockAgent[];
  subtasks?: MockSubtask[];
  settings?: Record<string, string>;
}) {
  const tasks = opts.tasks ?? [];
  const reviews = opts.reviews ?? [];
  const agents = opts.agents ?? [];
  const subtasks = opts.subtasks ?? [];
  const settings = opts.settings ?? {};

  return {
    prepare(sql: string) {
      const upper = sql.trim().toUpperCase();

      if (upper.includes("FROM TASKS WHERE")) {
        return {
          get: (taskId: unknown) => tasks.find((t) => t.id === taskId),
          all: () => tasks,
          run: () => {},
        };
      }

      if (upper.includes("FROM REVIEW_REVISION_HISTORY")) {
        return {
          get: () => reviews[0],
          all: (_taskId: unknown) => reviews.filter(() => true),
          run: () => {},
        };
      }

      if (upper.includes("FROM AGENTS")) {
        return {
          get: () => agents[0],
          all: () => agents.filter((a) => a.status !== "offline" && a.cli_provider),
          run: () => {},
        };
      }

      if (upper.includes("FROM SUBTASKS")) {
        return {
          get: () => subtasks[0],
          all: (_taskId: unknown) => subtasks,
          run: () => {},
        };
      }

      if (upper.includes("FROM SETTINGS")) {
        return {
          get: () => {
            if (upper.includes("CEOORCHESTRATOR")) {
              return settings.ceoOrchestratorModel ? { value: settings.ceoOrchestratorModel } : undefined;
            }
            return undefined;
          },
          all: () => [],
          run: () => {},
        };
      }

      if (upper.includes("FROM API_PROVIDERS")) {
        return {
          get: () => null,
          all: () => [],
          run: () => {},
        };
      }

      // Default
      return {
        get: () => undefined,
        all: () => [],
        run: () => {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — routeFollowUpViaCeo
// ---------------------------------------------------------------------------

describe("routeFollowUpViaCeo", () => {
  let appendTaskLog: ReturnType<typeof vi.fn>;
  let metrics: { incCounter: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    appendTaskLog = vi.fn();
    metrics = { incCounter: vi.fn() };
    mockResolveModel.mockReturnValue("gpt-4o-mini");
  });

  it("returns no_provider reason when no API provider is enabled", async () => {
    mockGetFirstEnabledProvider.mockReturnValue(null);

    const db = createMockDb({
      tasks: [
        {
          id: "t1",
          title: "Task",
          description: null,
          department_id: null,
          assigned_agent_id: null,
          status: "review",
          workflow_pack_key: "dev",
        },
      ],
    });

    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog, metrics }, "t1", "Fix the bug");

    expect(result).toEqual({ decision: null, reason: "no_provider" });
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "no_provider" });
  });

  it("returns task_not_found reason when task is not in DB", async () => {
    mockGetFirstEnabledProvider.mockReturnValue({
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    });

    const db = createMockDb({ tasks: [] }); // no tasks

    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog, metrics }, "missing-task", "Fix it");

    expect(result).toEqual({ decision: null, reason: "task_not_found" });
    expect(mockCallLlm).not.toHaveBeenCalled();
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "task_not_found" });
  });

  it("returns parsed supplement decision from LLM response", async () => {
    const provider = {
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    };
    mockGetFirstEnabledProvider.mockReturnValue(provider);
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        decision: "supplement",
        target_agent_id: "agent-dev-1",
        reasoning: "Minor fix, same agent can handle it",
      }),
    );

    const db = createMockDb({
      tasks: [
        {
          id: "t1",
          title: "Build login page",
          description: "Create a login page with OAuth",
          department_id: "dev",
          assigned_agent_id: "agent-dev-1",
          status: "review",
          workflow_pack_key: "development",
        },
      ],
    });

    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog, metrics }, "t1", "Fix the button color");

    expect(result.decision).not.toBeNull();
    expect(result.decision!.decision).toBe("supplement");
    expect(result.decision!.target_agent_id).toBe("agent-dev-1");
    expect(result.decision!.reasoning).toBe("Minor fix, same agent can handle it");
    expect((result as { source?: string }).source).toBe("llm");
    expect(appendTaskLog).toHaveBeenCalledWith("t1", "ceo-routing", expect.stringContaining("supplement"));
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "supplement" });
  });

  it("returns parsed pipeline_reset decision from LLM response", async () => {
    const provider = {
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    };
    mockGetFirstEnabledProvider.mockReturnValue(provider);
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        decision: "pipeline_reset",
        reset_from_phase: "design",
        reasoning: "Design phase output was wrong",
      }),
    );

    const db = createMockDb({
      tasks: [
        {
          id: "t2",
          title: "Redesign dashboard",
          description: "Full dashboard redesign",
          department_id: "design",
          assigned_agent_id: "agent-design-1",
          status: "review",
          workflow_pack_key: "design_studio",
        },
      ],
      subtasks: [
        { id: "st1", title: "[pipeline:design]", status: "done" },
        { id: "st2", title: "[pipeline:implementation]", status: "done" },
      ],
    });

    const result = await routeFollowUpViaCeo(
      { db: db as never, appendTaskLog, metrics },
      "t2",
      "The design is completely wrong",
    );

    expect(result.decision).not.toBeNull();
    expect(result.decision!.decision).toBe("pipeline_reset");
    expect(result.decision!.reset_from_phase).toBe("design");
    expect((result as { source?: string }).source).toBe("llm");
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "pipeline_reset" });
  });

  it("returns parsed new_task decision from LLM response", async () => {
    const provider = {
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    };
    mockGetFirstEnabledProvider.mockReturnValue(provider);
    mockCallLlm.mockResolvedValue(
      JSON.stringify({
        decision: "new_task",
        new_task_title: "Build mobile app",
        new_task_description: "Completely new scope: build a React Native app",
        reasoning: "This is unrelated to the web dashboard task",
      }),
    );

    const db = createMockDb({
      tasks: [
        {
          id: "t3",
          title: "Build web dashboard",
          description: "Dashboard for analytics",
          department_id: "dev",
          assigned_agent_id: "agent-dev-1",
          status: "review",
          workflow_pack_key: "development",
        },
      ],
    });

    const result = await routeFollowUpViaCeo(
      { db: db as never, appendTaskLog, metrics },
      "t3",
      "Build a mobile app instead",
    );

    expect(result.decision).not.toBeNull();
    expect(result.decision!.decision).toBe("new_task");
    expect(result.decision!.new_task_title).toBe("Build mobile app");
    expect(result.decision!.new_task_description).toBe("Completely new scope: build a React Native app");
    expect((result as { source?: string }).source).toBe("llm");
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "new_task" });
  });

  it("returns parse_error reason when LLM returns unparseable response", async () => {
    const provider = {
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    };
    mockGetFirstEnabledProvider.mockReturnValue(provider);
    mockCallLlm.mockResolvedValue("I think you should do supplement but here is my thoughts...");

    const db = createMockDb({
      tasks: [
        {
          id: "t4",
          title: "Task",
          description: null,
          department_id: null,
          assigned_agent_id: null,
          status: "review",
          workflow_pack_key: "development",
        },
      ],
    });

    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog, metrics }, "t4", "Fix it");

    expect(result).toEqual({ decision: null, reason: "parse_error" });
    expect(appendTaskLog).toHaveBeenCalledWith("t4", "ceo-routing", expect.stringContaining("Failed to parse"));
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "parse_error" });
  });

  it("returns llm_error reason when LLM call throws an error", async () => {
    const provider = {
      id: "p1",
      name: "OpenAI",
      type: "openai",
      base_url: "https://api.openai.com",
      api_key_enc: "key",
      models_cache: null,
      enabled: 1,
    };
    mockGetFirstEnabledProvider.mockReturnValue(provider);
    mockCallLlm.mockRejectedValue(new Error("API rate limited"));

    const db = createMockDb({
      tasks: [
        {
          id: "t5",
          title: "Task",
          description: null,
          department_id: null,
          assigned_agent_id: null,
          status: "review",
          workflow_pack_key: "development",
        },
      ],
    });

    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog, metrics }, "t5", "Fix it");

    expect(result).toEqual({ decision: null, reason: "llm_error" });
    expect(appendTaskLog).toHaveBeenCalledWith("t5", "ceo-routing", expect.stringContaining("error"));
    expect(metrics.incCounter).toHaveBeenCalledWith("ceo.followup.routing", { result: "llm_error" });
  });

  it("works without metrics dep (optional)", async () => {
    mockGetFirstEnabledProvider.mockReturnValue(null);

    const db = createMockDb({
      tasks: [
        {
          id: "t6",
          title: "Task",
          description: null,
          department_id: null,
          assigned_agent_id: null,
          status: "review",
          workflow_pack_key: "dev",
        },
      ],
    });

    // No metrics provided
    const result = await routeFollowUpViaCeo({ db: db as never, appendTaskLog }, "t6", "Fix the bug");

    expect(result).toEqual({ decision: null, reason: "no_provider" });
  });
});

// ---------------------------------------------------------------------------
// parseFollowUpDecision — additional edge cases
// ---------------------------------------------------------------------------

describe("parseFollowUpDecision — additional edge cases", () => {
  it("handles JSON with extra whitespace", () => {
    const raw = `

    {
      "decision": "supplement",
      "reasoning": "Whitespace test"
    }

    `;
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("supplement");
  });

  it("handles code fence without json language tag", () => {
    const raw = '```\n{"decision": "supplement", "reasoning": "test"}\n```';
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe("supplement");
  });

  it("defaults reasoning to empty string when missing", () => {
    const raw = JSON.stringify({ decision: "supplement" });
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.reasoning).toBe("");
  });

  it("handles optional fields gracefully", () => {
    const raw = JSON.stringify({
      decision: "supplement",
      reasoning: "test",
      // target_agent_id and target_department_id are omitted
    });
    const result = parseFollowUpDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.target_agent_id).toBeUndefined();
    expect(result!.target_department_id).toBeUndefined();
  });

  it("returns null for empty string", () => {
    expect(parseFollowUpDecision("")).toBeNull();
  });

  it("returns null for null-ish input", () => {
    expect(parseFollowUpDecision(undefined as unknown as string)).toBeNull();
  });

  it("returns null for pipeline_reset with non-string reset_from_phase", () => {
    const raw = JSON.stringify({
      decision: "pipeline_reset",
      reset_from_phase: 42,
      reasoning: "number instead of string",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });

  it("returns null for new_task with non-string title", () => {
    const raw = JSON.stringify({
      decision: "new_task",
      new_task_title: { nested: "object" },
      reasoning: "object instead of string",
    });
    expect(parseFollowUpDecision(raw)).toBeNull();
  });
});
