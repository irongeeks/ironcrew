import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPlanningArchiveTools } from "./planning-archive-tools.ts";

type MockStmt = {
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

type SqlPlan = {
  rootTask?: any;
  relatedTasks?: any[];
  reportByTaskId?: Record<string, any>;
  insertRun?: ReturnType<typeof vi.fn>;
};

function makeDb(plan: SqlPlan) {
  const insertRun = plan.insertRun ?? vi.fn();
  const calls: Array<{ sql: string; stmt: MockStmt }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt: MockStmt = {
        get: vi.fn(),
        all: vi.fn(),
        run: vi.fn(),
      };
      const trimmed = sql.replace(/\s+/g, " ").trim();
      if (trimmed.startsWith("SELECT id, title, description, project_path")) {
        stmt.get.mockReturnValue(plan.rootTask);
      } else if (trimmed.startsWith("SELECT t.id, t.title, t.status")) {
        stmt.all.mockReturnValue(plan.relatedTasks ?? []);
      } else if (trimmed.startsWith("SELECT m.content, m.created_at")) {
        stmt.get.mockImplementation((taskId: string) => plan.reportByTaskId?.[taskId]);
      } else if (trimmed.startsWith("INSERT INTO task_report_archives")) {
        stmt.run = insertRun;
      }
      calls.push({ sql: trimmed, stmt });
      return stmt;
    }),
  };
  return { db, insertRun, calls };
}

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
  const findTeamLeader = vi.fn().mockReturnValue({ id: "leader-1", name: "Planning Lead" });
  const runAgentOneShot = vi.fn().mockResolvedValue({ text: "x".repeat(500) });
  const normalizeConversationReply = vi.fn((s: string) => s);
  const appendTaskLog = vi.fn();
  const sendAgentMessage = vi.fn();
  const broadcast = vi.fn();
  const pickL = vi.fn((bundle: any, _lang: string) => {
    if (Array.isArray(bundle)) return bundle[1]?.[0] ?? "";
    return "";
  });
  const l = vi.fn((ko: string[], en: string[], ja: string[], zh: string[]) => [ko, en, ja, zh]);
  const resolveLang = vi.fn().mockReturnValue("en");
  const nowMs = vi.fn(() => 1234567890);
  const randomUUID = vi.fn(() => "uuid-1");

  return {
    nowMs,
    randomUUID,
    appendTaskLog,
    sendAgentMessage,
    broadcast,
    pickL,
    l,
    resolveLang,
    runAgentOneShot,
    normalizeConversationReply,
    findTeamLeader,
    ...overrides,
  };
}

describe("createPlanningArchiveTools", () => {
  describe("cleanArchiveText", () => {
    let tools: ReturnType<typeof createPlanningArchiveTools>;
    beforeEach(() => {
      tools = createPlanningArchiveTools({ db: {}, ...makeDeps() } as any);
    });

    it("returns empty string for non-string and empty inputs", () => {
      expect(tools.cleanArchiveText(undefined)).toBe("");
      expect(tools.cleanArchiveText(null)).toBe("");
      expect(tools.cleanArchiveText(123)).toBe("");
      expect(tools.cleanArchiveText("")).toBe("");
    });

    it("normalizes escaped newlines and tabs", () => {
      expect(tools.cleanArchiveText("hello\\nworld")).toBe("hello\nworld");
      expect(tools.cleanArchiveText("a\\tb")).toBe("a b");
      expect(tools.cleanArchiveText("a\\r\\nb")).toBe("a\nb");
    });

    it("strips ANSI color codes", () => {
      expect(tools.cleanArchiveText("[31mred[0m text")).toBe("red text");
    });

    it("filters JSON event lines and noise", () => {
      const input = [
        '{"type":"item.completed","data":1}',
        '{"id":"item_abc"}',
        '{"aggregated_output":"x"}',
        "(Use `node --trace-warnings ...`)",
        "command 'foo'",
        "[server] listening on http://localhost:8790",
        "real content",
      ].join("\n");
      expect(tools.cleanArchiveText(input)).toBe("real content");
    });

    it("trims trailing whitespace and blank lines", () => {
      expect(tools.cleanArchiveText("  line1   \n\n   line2   ")).toBe("line1\nline2");
    });
  });

  describe("clipArchiveText", () => {
    let tools: ReturnType<typeof createPlanningArchiveTools>;
    beforeEach(() => {
      tools = createPlanningArchiveTools({ db: {}, ...makeDeps() } as any);
    });

    it("returns empty for empty text", () => {
      expect(tools.clipArchiveText("")).toBe("");
      expect(tools.clipArchiveText(null)).toBe("");
    });

    it("returns full text when under maxChars", () => {
      expect(tools.clipArchiveText("short text", 100)).toBe("short text");
    });

    it("clips and adds ellipsis when over maxChars", () => {
      const long = "a".repeat(50);
      const result = tools.clipArchiveText(long, 10);
      expect(result.endsWith("...")).toBe(true);
      expect(result.length).toBeLessThanOrEqual(13);
    });

    it("returns full text when maxChars is 0 or non-finite", () => {
      const text = "some text";
      expect(tools.clipArchiveText(text, 0)).toBe("some text");
      expect(tools.clipArchiveText(text, -1)).toBe("some text");
      expect(tools.clipArchiveText(text, Number.NaN)).toBe("some text");
    });
  });

  describe("buildFallbackPlanningArchive", () => {
    it("builds markdown with header, summary, team sections", () => {
      const tools = createPlanningArchiveTools({ db: {}, ...makeDeps() } as any);
      const root = { title: "MyProject" };
      const entries = [
        {
          title: "Task 1",
          dept_name: "Eng",
          agent_name: "Alice",
          status: "completed",
          completed_at: 1700000000000,
          latest_report: "did stuff",
          result_snippet: "ok",
        },
      ];
      const md = tools.buildFallbackPlanningArchive(root, entries, "en");
      expect(md).toContain("MyProject");
      expect(md).toContain("### 1. Task 1");
      expect(md).toContain("- Department: Eng");
      expect(md).toContain("- Agent: Alice");
      expect(md).toContain("- Status: completed");
      expect(md).toContain(new Date(1700000000000).toISOString());
    });

    it("handles missing fields with defaults", () => {
      const tools = createPlanningArchiveTools({ db: {}, ...makeDeps() } as any);
      const md = tools.buildFallbackPlanningArchive({}, [{}], "en");
      expect(md).toContain("### 1. Task");
      expect(md).toContain("- Department: -");
      expect(md).toContain("- Agent: -");
      expect(md).toContain("- Completed: -");
    });

    it("returns header-only output for empty entries", () => {
      const tools = createPlanningArchiveTools({ db: {}, ...makeDeps() } as any);
      const md = tools.buildFallbackPlanningArchive({ title: "P" }, [], "en");
      expect(md).toContain("Final Consolidated Report: P");
      expect(md).not.toContain("### 1.");
    });
  });

  describe("archivePlanningConsolidatedReport", () => {
    it("returns early when root task is not found", async () => {
      const { db } = makeDb({ rootTask: undefined });
      const deps = makeDeps();
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("missing");
      expect(deps.findTeamLeader).not.toHaveBeenCalled();
      expect(deps.broadcast).not.toHaveBeenCalled();
    });

    it("returns early when no planning leader is found", async () => {
      const { db } = makeDb({
        rootTask: {
          id: "r1",
          title: "T",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: null,
        },
      });
      const deps = makeDeps({ findTeamLeader: vi.fn().mockReturnValue(null) });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      expect(deps.appendTaskLog).not.toHaveBeenCalled();
    });

    it("returns early when there are no related tasks", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "T",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: "planning",
        },
        relatedTasks: [],
      });
      const deps = makeDeps();
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      expect(insertRun).not.toHaveBeenCalled();
      expect(deps.broadcast).not.toHaveBeenCalled();
    });

    it("happy path: generates summary via agent and inserts archive", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "Project X",
          description: "desc",
          project_path: "/tmp/project",
          completed_at: 1700,
          department_id: "planning",
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub 1",
            status: "completed",
            department_id: "eng",
            dept_name: "Eng",
            agent_name: "Alice",
            completed_at: 1700,
            result: "OK result",
          },
        ],
        reportByTaskId: {
          t1: { content: "Latest report content", created_at: 1234 },
        },
      });
      const longSummary = "## Summary\n" + "real summary content ".repeat(30);
      const deps = makeDeps({
        runAgentOneShot: vi.fn().mockResolvedValue({ text: longSummary }),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");

      expect(deps.runAgentOneShot).toHaveBeenCalledTimes(1);
      const [, prompt, opts] = deps.runAgentOneShot.mock.calls[0];
      expect(prompt).toContain("Project X");
      expect(prompt).toContain("Sub 1");
      expect(opts).toMatchObject({ projectPath: "/tmp/project", noTools: true });

      expect(insertRun).toHaveBeenCalledTimes(1);
      const args = insertRun.mock.calls[0];
      expect(args[0]).toBe("uuid-1");
      expect(args[1]).toBe("r1");
      expect(args[2]).toBe("leader-1");
      expect(args[3]).toContain("real summary content");

      // schema check: snapshot must be parseable JSON with shape
      const snapshot = JSON.parse(args[4]);
      expect(snapshot).toMatchObject({
        root_task_id: "r1",
        generated_at: 1234567890,
      });
      expect(Array.isArray(snapshot.entries)).toBe(true);
      expect(snapshot.entries[0]).toMatchObject({ id: "t1", title: "Sub 1" });

      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        "r1",
        "system",
        expect.stringContaining("Planning consolidated archive updated"),
      );
      expect(deps.sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(deps.broadcast).toHaveBeenCalledWith("task_report", { task: { id: "r1" } });
    });

    it("uses fallback markdown when agent throws", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "Project X",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: null,
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: "d1",
            dept_name: "D1",
            agent_name: "A",
            completed_at: 0,
            result: null,
          },
        ],
      });
      const deps = makeDeps({
        runAgentOneShot: vi.fn().mockRejectedValue(new Error("agent failed")),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");

      expect(insertRun).toHaveBeenCalledTimes(1);
      const md = insertRun.mock.calls[0][3] as string;
      expect(md).toContain("Final Consolidated Report");
      expect(deps.broadcast).toHaveBeenCalled();
    });

    it("uses fallback when summary is too short", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "P",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: null,
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: null,
            dept_name: "",
            agent_name: "",
            completed_at: 0,
            result: null,
          },
        ],
      });
      const deps = makeDeps({
        runAgentOneShot: vi.fn().mockResolvedValue({ text: "tiny" }),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      const md = insertRun.mock.calls[0][3] as string;
      expect(md).toContain("Final Consolidated Report");
    });

    it("appends evidence snapshot when summary lacks header", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "P",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: null,
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: null,
            dept_name: "Dep",
            agent_name: "Bob",
            completed_at: 0,
            result: "result text",
          },
        ],
      });
      const longSummary = "summary content ".repeat(40);
      const deps = makeDeps({
        runAgentOneShot: vi.fn().mockResolvedValue({ text: longSummary }),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      const md = insertRun.mock.calls[0][3] as string;
      expect(md).toContain("Consolidation Evidence Snapshot");
      expect(md).toContain("- Department: Dep");
      expect(md).toContain("- Agent: Bob");
    });

    it("does not duplicate evidence snapshot if header already present (idempotency)", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "P",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: null,
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: null,
            dept_name: "Dep",
            agent_name: "Bob",
            completed_at: 0,
            result: null,
          },
        ],
      });
      const summary = "## Consolidation Evidence Snapshot\n" + "manual evidence content ".repeat(30);
      const deps = makeDeps({
        runAgentOneShot: vi.fn().mockResolvedValue({ text: summary }),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      const md = insertRun.mock.calls[0][3] as string;
      const occurrences = md.match(/Consolidation Evidence Snapshot/g)?.length ?? 0;
      expect(occurrences).toBe(1);
    });

    it("swallows DB errors and does not throw", async () => {
      const db = {
        prepare: vi.fn(() => {
          throw new Error("db boom");
        }),
      };
      const deps = makeDeps();
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await expect(tools.archivePlanningConsolidatedReport("r1")).resolves.toBeUndefined();
      expect(deps.broadcast).not.toHaveBeenCalled();
    });

    it("falls back to root task department when planning leader missing", async () => {
      const { db, insertRun } = makeDb({
        rootTask: {
          id: "r1",
          title: "P",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: "research",
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: null,
            dept_name: "",
            agent_name: "",
            completed_at: 0,
            result: null,
          },
        ],
      });
      const findTeamLeader = vi
        .fn()
        .mockImplementation((dept: string) => (dept === "research" ? { id: "rl", name: "Res Lead" } : null));
      const deps = makeDeps({
        findTeamLeader,
        runAgentOneShot: vi.fn().mockResolvedValue({ text: "x".repeat(500) }),
      });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      expect(findTeamLeader).toHaveBeenCalledWith("planning");
      expect(findTeamLeader).toHaveBeenCalledWith("research");
      expect(insertRun).toHaveBeenCalled();
    });

    it("uses cwd as projectPath when root task has no project_path", async () => {
      const { db } = makeDb({
        rootTask: {
          id: "r1",
          title: "P",
          description: null,
          project_path: null,
          completed_at: null,
          department_id: "planning",
        },
        relatedTasks: [
          {
            id: "t1",
            title: "Sub",
            status: "done",
            department_id: null,
            dept_name: "",
            agent_name: "",
            completed_at: 0,
            result: null,
          },
        ],
      });
      const runAgentOneShot = vi.fn().mockResolvedValue({ text: "x".repeat(500) });
      const deps = makeDeps({ runAgentOneShot });
      const tools = createPlanningArchiveTools({ db, ...deps } as any);
      await tools.archivePlanningConsolidatedReport("r1");
      const opts = runAgentOneShot.mock.calls[0][2];
      expect(opts.projectPath).toBe(process.cwd());
    });
  });
});
