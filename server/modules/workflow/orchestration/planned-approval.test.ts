import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPlannedApprovalTools } from "./planned-approval.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Leader = {
  id: string;
  department_id: string;
  role: string;
};

const planningLeader: Leader = { id: "leader-planning", department_id: "planning", role: "lead" };
const devLeader: Leader = { id: "leader-dev", department_id: "development", role: "lead" };
const qaLeader: Leader = { id: "leader-qa", department_id: "qa", role: "lead" };

function buildTaskRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    description: "task description",
    project_path: "workspaces/test",
    workflow_pack_key: "development",
    ...overrides,
  };
}

function makeDb(taskRow: ReturnType<typeof buildTaskRow> | undefined = buildTaskRow()) {
  return {
    prepare(_sql: string) {
      return {
        get: vi.fn(() => taskRow),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      };
    },
  } as unknown as Parameters<typeof createPlannedApprovalTools>[0]["db"];
}

type Run = { text?: string; error?: string };

interface DepsOverrides {
  leaders?: Leader[];
  taskRow?: ReturnType<typeof buildTaskRow> | undefined;
  runAgentOneShotImpl?: (agent: any, prompt: string, opts: any) => Promise<Run>;
  isTaskWorkflowInterruptedImpl?: (taskId: string) => boolean;
  collectPlannedActionItemsImpl?: (transcript: any[], max: number) => any[];
  beginMeetingMinutesImpl?: () => string | null;
  reviewInFlight?: Set<string>;
  reviewRoundState?: Map<string, number>;
  reviewMeetingOneShotTimeoutMs?: number;
}

function makeDeps(overrides: DepsOverrides = {}) {
  const leaders = overrides.leaders ?? [planningLeader, devLeader, qaLeader];
  const calls = {
    sendAgentMessage: vi.fn(),
    emitMeetingSpeech: vi.fn(),
    appendMeetingMinuteEntry: vi.fn(),
    notifyCeo: vi.fn(),
    callLeadersToCeoOffice: vi.fn(),
    dismissLeadersFromCeoOffice: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    finishMeetingMinutes: vi.fn(),
    beginMeetingMinutes: vi.fn(overrides.beginMeetingMinutesImpl ?? (() => "meeting-1")),
    appendTaskLog: vi.fn(),
    appendTaskProjectMemo: vi.fn(),
    runAgentOneShot: vi.fn(
      overrides.runAgentOneShotImpl ??
        (async (_agent: any, _prompt: string) => ({ text: "actionable plan item" }) as Run),
    ),
    isTaskWorkflowInterrupted: vi.fn(overrides.isTaskWorkflowInterruptedImpl ?? (() => false)),
    collectPlannedActionItems: vi.fn(
      overrides.collectPlannedActionItemsImpl ??
        ((transcript: any[]) => transcript.slice(0, 3).map((t, i) => ({ idx: i, text: t.content }))),
    ),
  };

  const deps = {
    reviewInFlight: overrides.reviewInFlight ?? new Set<string>(),
    reviewRoundState: overrides.reviewRoundState ?? new Map<string, number>(),
    db: makeDb(overrides.taskRow),
    getTaskReviewLeaders: vi.fn(() => leaders.slice()),
    resolveProjectPath: vi.fn(() => "/tmp/proj"),
    resolveLang: vi.fn(() => "en"),
    beginMeetingMinutes: calls.beginMeetingMinutes,
    isTaskWorkflowInterrupted: calls.isTaskWorkflowInterrupted,
    getTaskStatusById: vi.fn(() => "in_progress"),
    finishMeetingMinutes: calls.finishMeetingMinutes,
    dismissLeadersFromCeoOffice: calls.dismissLeadersFromCeoOffice,
    clearTaskWorkflowState: calls.clearTaskWorkflowState,
    getAgentDisplayName: vi.fn((leader: any) => `Display:${leader.id}`),
    getDeptName: vi.fn((id: string) => `Dept:${id}`),
    getRoleLabel: vi.fn((role: string) => `Role:${role}`),
    sendAgentMessage: calls.sendAgentMessage,
    emitMeetingSpeech: calls.emitMeetingSpeech,
    appendMeetingMinuteEntry: calls.appendMeetingMinuteEntry,
    callLeadersToCeoOffice: calls.callLeadersToCeoOffice,
    notifyCeo: calls.notifyCeo,
    pickL: vi.fn((arrs: string[][], _lang: string) => arrs[0]?.[0] ?? ""),
    l: vi.fn((...arrs: string[][]) => arrs),
    buildMeetingPrompt: vi.fn((_leader: any, ctx: any) => `prompt:${ctx.turnObjective}`),
    runAgentOneShot: calls.runAgentOneShot,
    chooseSafeReply: vi.fn((run: Run, _lang: string, phase: string) => run?.text ?? `fallback:${phase}`),
    sleepMs: vi.fn(async () => undefined),
    randomDelay: vi.fn(() => 0),
    collectPlannedActionItems: calls.collectPlannedActionItems,
    appendTaskProjectMemo: calls.appendTaskProjectMemo,
    appendTaskLog: calls.appendTaskLog,
    reviewMeetingOneShotTimeoutMs: overrides.reviewMeetingOneShotTimeoutMs,
  };

  return { deps, calls, leaders };
}

// Run startPlannedApprovalMeeting and wait for the internal IIFE to settle.
async function runMeetingAndWait(
  toolsDeps: ReturnType<typeof makeDeps>,
  options: {
    taskId?: string;
    taskTitle?: string;
    departmentId?: string | null;
  } = {},
): Promise<{ approved: boolean; planningNotes?: any[] }> {
  const taskId = options.taskId ?? "task-1";
  const taskTitle = options.taskTitle ?? "Test Task";
  const departmentId = options.departmentId ?? null;

  const tools = createPlannedApprovalTools(toolsDeps.deps);

  return new Promise<{ approved: boolean; planningNotes?: any[] }>((resolve) => {
    let resolved = false;
    const finish = (approved: boolean, notes?: any[]) => {
      if (resolved) return;
      resolved = true;
      resolve({ approved, planningNotes: notes });
    };

    const onApproved = (notes?: any[]) => finish(true, notes);

    // Failure / abort paths: detect via terminal cleanup mocks.
    toolsDeps.calls.dismissLeadersFromCeoOffice.mockImplementation(() => {
      setTimeout(() => finish(false), 0);
    });
    toolsDeps.calls.clearTaskWorkflowState.mockImplementation(() => {
      setTimeout(() => finish(false), 0);
    });

    tools.startPlannedApprovalMeeting(taskId, taskTitle, departmentId, onApproved);

    // Safety: time out after 2s.
    setTimeout(() => finish(false), 2000);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPlannedApprovalTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes startPlannedApprovalMeeting", () => {
    const { deps } = makeDeps();
    const tools = createPlannedApprovalTools(deps);
    expect(typeof tools.startPlannedApprovalMeeting).toBe("function");
  });

  it("short-circuits with empty plan when no review leaders are configured", () => {
    const harness = makeDeps({ leaders: [] });
    const onApproved = vi.fn();
    const tools = createPlannedApprovalTools(harness.deps);

    tools.startPlannedApprovalMeeting("task-empty", "T", null, onApproved);

    expect(onApproved).toHaveBeenCalledWith([]);
    expect(harness.calls.beginMeetingMinutes).not.toHaveBeenCalled();
    expect(harness.deps.reviewInFlight.size).toBe(0);
  });

  it("ignores re-entrant calls when meeting is already in flight", () => {
    const reviewInFlight = new Set<string>(["planned:task-1"]);
    const harness = makeDeps({ reviewInFlight });
    const tools = createPlannedApprovalTools(harness.deps);
    const onApproved = vi.fn();

    tools.startPlannedApprovalMeeting("task-1", "T", null, onApproved);

    expect(onApproved).not.toHaveBeenCalled();
    expect(harness.deps.getTaskReviewLeaders).not.toHaveBeenCalled();
  });

  it("runs full happy path: opening, feedback, summary, action; calls onApproved with plan items", async () => {
    const harness = makeDeps();
    const result = await runMeetingAndWait(harness);

    expect(result.approved).toBe(true);
    expect(result.planningNotes).toBeDefined();

    expect(harness.calls.sendAgentMessage).toHaveBeenCalled();
    expect(harness.calls.emitMeetingSpeech).toHaveBeenCalled();

    expect(harness.calls.notifyCeo).toHaveBeenCalledTimes(2);
    expect(harness.calls.callLeadersToCeoOffice).toHaveBeenCalledTimes(1);

    expect(harness.deps.reviewRoundState.has("planned:task-1")).toBe(false);
    expect(harness.deps.reviewInFlight.has("planned:task-1")).toBe(false);

    expect(harness.calls.appendTaskProjectMemo).toHaveBeenCalledWith("task-1", "planned", 1, expect.any(Array), "en");
    expect(harness.calls.finishMeetingMinutes).toHaveBeenCalledWith("meeting-1", "completed");
    expect(harness.calls.dismissLeadersFromCeoOffice).toHaveBeenCalled();

    // 1 opening + 2 feedback + 1 summary + 3 approval = 7.
    expect(harness.calls.runAgentOneShot).toHaveBeenCalledTimes(7);
  });

  it("increments round counter from prior rounds when retried", async () => {
    // Simulate a prior round having occurred (without success-clear).
    const reviewRoundState = new Map<string, number>([["planned:task-1", 2]]);
    const harness = makeDeps({ reviewRoundState });
    await runMeetingAndWait(harness);

    const calls = harness.deps.buildMeetingPrompt as ReturnType<typeof vi.fn>;
    const allRounds = calls.mock.calls.map((c: any[]) => c[1]?.round);
    expect(allRounds).toContain(3);
  });

  it("clears round counter on successful completion", async () => {
    const reviewRoundState = new Map<string, number>();
    const harness = makeDeps({ reviewRoundState });
    await runMeetingAndWait(harness);
    expect(reviewRoundState.has("planned:task-1")).toBe(false);
  });

  it("falls back to safe reply when runAgentOneShot returns empty/undefined text", async () => {
    const harness = makeDeps({
      runAgentOneShotImpl: async () => ({ text: undefined }),
    });
    await runMeetingAndWait(harness);
    expect(harness.deps.chooseSafeReply).toHaveBeenCalled();
    const sentTexts = (harness.calls.sendAgentMessage.mock.calls as any[][]).map((c) => c[1]);
    expect(sentTexts.some((t) => /fallback:/.test(t))).toBe(true);
  });

  it("retries once with compacted prompt on timeout, then continues", async () => {
    let call = 0;
    const harness = makeDeps({
      runAgentOneShotImpl: async () => {
        call += 1;
        if (call === 1) return { text: "", error: "request timed out" };
        return { text: `ok` };
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);

    const logs = (harness.calls.appendTaskLog.mock.calls as any[][]).map((c) => c[2]);
    expect(logs.some((m) => /timed out.*retrying once with compact prompt/.test(m))).toBe(true);
  });

  it("logs both attempts when timeout retry also times out", async () => {
    const harness = makeDeps({
      runAgentOneShotImpl: async () => ({ text: "", error: "timeout after 65000ms" }),
    });
    await runMeetingAndWait(harness);

    const logs = (harness.calls.appendTaskLog.mock.calls as any[][]).map((c) => c[2]);
    expect(logs.some((m) => /retrying once/.test(m))).toBe(true);
    expect(logs.some((m) => /retry timed out/.test(m))).toBe(true);
  });

  it("compacts very long prompts on timeout retry", async () => {
    const longHead = "A".repeat(3000);
    const longTail = "B".repeat(2000);
    const harness = makeDeps({
      runAgentOneShotImpl: async () => ({ text: "", error: "request timed out" }),
    });
    (harness.deps.buildMeetingPrompt as ReturnType<typeof vi.fn>).mockImplementation(() => longHead + longTail);

    await runMeetingAndWait(harness);

    const calls = harness.calls.runAgentOneShot.mock.calls as any[][];
    const retryPrompts = calls.map((c) => String(c[1] ?? ""));
    expect(retryPrompts.some((p) => /timeout retry compacted/.test(p))).toBe(true);
  });

  it("flags supplement signals when feedback contains revision keywords", async () => {
    let call = 0;
    const harness = makeDeps({
      runAgentOneShotImpl: async () => {
        call += 1;
        if (call === 2 || call === 3) return { text: "revision required, please add tests" };
        return { text: "all good" };
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);

    const sysLogs = (harness.calls.appendTaskLog.mock.calls as any[][]).map((c) => c[2]);
    expect(sysLogs.some((m) => /supplement-signals=yes/.test(m))).toBe(true);
  });

  it("flags supplement signals when an action item contains revision keywords", async () => {
    let call = 0;
    const harness = makeDeps({
      runAgentOneShotImpl: async () => {
        call += 1;
        // Calls 5,6,7 are the action-phase loop (one per leader).
        if (call === 5) return { text: "hold: needs additional risk review" };
        return { text: "all good" };
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);
    const sysLogs = (harness.calls.appendTaskLog.mock.calls as any[][]).map((c) => c[2]);
    expect(sysLogs.some((m) => /supplement-signals=yes/.test(m))).toBe(true);
  });

  it("records supplement-signals=no when no revision keywords appear", async () => {
    const harness = makeDeps({
      runAgentOneShotImpl: async () => ({ text: "ready to ship, all clear" }),
    });
    await runMeetingAndWait(harness);
    const sysLogs = (harness.calls.appendTaskLog.mock.calls as any[][]).map((c) => c[2]);
    expect(sysLogs.some((m) => /supplement-signals=no/.test(m))).toBe(true);
  });

  it("aborts cleanly mid-meeting when task workflow becomes interrupted", async () => {
    let n = 0;
    const harness = makeDeps({
      isTaskWorkflowInterruptedImpl: () => {
        n += 1;
        return n > 2;
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);

    expect(harness.calls.finishMeetingMinutes).toHaveBeenCalledWith("meeting-1", "failed");
    expect(harness.calls.dismissLeadersFromCeoOffice).toHaveBeenCalled();
    expect(harness.calls.clearTaskWorkflowState).toHaveBeenCalled();
    expect(harness.calls.appendTaskProjectMemo).not.toHaveBeenCalled();
  });

  it("aborts during the feedback loop when interruption flips after opening", async () => {
    let count = 0;
    const harness = makeDeps({
      isTaskWorkflowInterruptedImpl: () => {
        count += 1;
        // Allow opening to complete; interrupt during feedback iteration checks.
        return count > 5;
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);
    expect(harness.calls.clearTaskWorkflowState).toHaveBeenCalled();
  });

  it("aborts during the action-item loop when interruption flips late", async () => {
    let count = 0;
    const harness = makeDeps({
      isTaskWorkflowInterruptedImpl: () => {
        count += 1;
        // Permit opening + feedback + summary; abort once action loop begins.
        return count > 14;
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);
    expect(harness.calls.appendTaskProjectMemo).not.toHaveBeenCalled();
  });

  it("aborts immediately when task is interrupted before kickoff", async () => {
    const harness = makeDeps({ isTaskWorkflowInterruptedImpl: () => true });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);
    expect(harness.calls.finishMeetingMinutes).toHaveBeenCalledWith("meeting-1", "failed");
    expect(harness.calls.runAgentOneShot).not.toHaveBeenCalled();
  });

  it("handles errors from runAgentOneShot by failing meeting and notifying CEO", async () => {
    const harness = makeDeps({
      runAgentOneShotImpl: async () => {
        throw new Error("model unavailable");
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);

    const errorLogs = (harness.calls.appendTaskLog.mock.calls as any[][]).filter((c) => c[1] === "error");
    expect(errorLogs.some((c) => /Planned meeting error: .*model unavailable/.test(String(c[2])))).toBe(true);

    expect(harness.calls.finishMeetingMinutes).toHaveBeenCalledWith("meeting-1", "failed");
    expect(harness.calls.dismissLeadersFromCeoOffice).toHaveBeenCalled();
    expect(harness.calls.notifyCeo).toHaveBeenCalled();
  });

  it("does not log error/notify when interruption raced with a thrown error", async () => {
    let interrupted = false;
    const harness = makeDeps({
      isTaskWorkflowInterruptedImpl: () => interrupted,
      runAgentOneShotImpl: async () => {
        interrupted = true;
        throw new Error("boom");
      },
    });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(false);

    const errorLogs = (harness.calls.appendTaskLog.mock.calls as any[][]).filter((c) => c[1] === "error");
    expect(errorLogs.length).toBe(0);
    expect(harness.calls.clearTaskWorkflowState).toHaveBeenCalled();
  });

  it("uses the custom one-shot timeout when provided", async () => {
    const harness = makeDeps({ reviewMeetingOneShotTimeoutMs: 12_345 });
    await runMeetingAndWait(harness);
    const calls = harness.calls.runAgentOneShot.mock.calls as any[][];
    expect(calls[0]?.[2]?.timeoutMs).toBe(12_345);
  });

  it("clamps absurdly low timeouts to the 5_000 ms floor", async () => {
    const harness = makeDeps({ reviewMeetingOneShotTimeoutMs: 100 });
    await runMeetingAndWait(harness);
    const calls = harness.calls.runAgentOneShot.mock.calls as any[][];
    expect(calls[0]?.[2]?.timeoutMs).toBe(5_000);
  });

  it("falls back to cwd when resolveProjectPath returns null", async () => {
    const harness = makeDeps();
    (harness.deps.resolveProjectPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await runMeetingAndWait(harness);
    const calls = harness.calls.runAgentOneShot.mock.calls as any[][];
    expect(typeof calls[0]?.[2]?.projectPath).toBe("string");
    expect(calls[0]?.[2]?.projectPath.length).toBeGreaterThan(0);
  });

  it("works when DB has no task row (description/path null)", async () => {
    const harness = makeDeps({ taskRow: undefined });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);
    expect(harness.calls.appendTaskProjectMemo).toHaveBeenCalled();
  });

  it("records meeting transcripts via appendMeetingMinuteEntry", async () => {
    const harness = makeDeps();
    await runMeetingAndWait(harness);
    expect(harness.calls.appendMeetingMinuteEntry).toHaveBeenCalledTimes(7);
  });

  it("falls back to the first leader when no planning department leader is present", async () => {
    const leaders = [devLeader, qaLeader];
    const harness = makeDeps({ leaders });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);

    const promptCalls = (harness.deps.buildMeetingPrompt as ReturnType<typeof vi.fn>).mock.calls as any[][];
    expect(promptCalls[0]?.[0]?.id).toBe("leader-dev");
  });

  it("skips meeting minute entries when beginMeetingMinutes returns null", async () => {
    const harness = makeDeps({ beginMeetingMinutesImpl: () => null });
    const result = await runMeetingAndWait(harness);
    expect(result.approved).toBe(true);
    expect(harness.calls.appendMeetingMinuteEntry).not.toHaveBeenCalled();
    expect(harness.calls.finishMeetingMinutes).not.toHaveBeenCalled();
  });
});
