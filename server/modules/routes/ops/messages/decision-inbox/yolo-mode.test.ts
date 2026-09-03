import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildYoloDecisionReplyPayload,
  readYoloModeEnabled,
  runYoloDecisionAutopilot,
  type DecisionApplyResult,
} from "./yolo-mode.ts";
import type { DecisionInboxRouteItem } from "./types.ts";

function createItem(overrides: Partial<DecisionInboxRouteItem>): DecisionInboxRouteItem {
  return {
    id: "decision-1",
    kind: "project_review_ready",
    created_at: 1,
    summary: "",
    project_id: "project-1",
    project_name: "Project",
    project_path: "/tmp/project",
    task_id: null,
    task_title: null,
    options: [],
    ...overrides,
  };
}

describe("readYoloModeEnabled", () => {
  it("settings.yoloMode=true를 읽으면 활성화된다", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO settings (key, value) VALUES ('yoloMode', 'true')").run();
      expect(readYoloModeEnabled(db as any)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("값이 없으면 비활성으로 본다", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
      expect(readYoloModeEnabled(db as any)).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("buildYoloDecisionReplyPayload", () => {
  it("project_review_ready에서 대표선택 이후 start_project_review를 자동 선택한다", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        kind: "project_review_ready",
        options: [
          { number: 1, action: "start_project_review", label: "Start" },
          { number: 2, action: "add_followup_request", label: "Follow-up" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 1 });
  });

  it("project_review_ready에 대표선택과 start가 함께 있으면 대표선택을 우선한다", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        kind: "project_review_ready",
        options: [
          { number: 1, action: "start_project_review", label: "Start" },
          { number: 2, action: "approve_task_review:task-a", label: "A" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2 });
  });

  it("review_round_pick에서 summary 권장 번호를 다중 선택으로 반영한다", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        id: "decision-round",
        kind: "review_round_pick",
        summary: "Recommended picks: 2 and 1",
        task_id: "task-1",
        task_title: "Task",
        meeting_id: "meeting-1",
        review_round: 1,
        options: [
          { number: 1, action: "apply_review_pick", label: "one" },
          { number: 2, action: "apply_review_pick", label: "two" },
          { number: 3, action: "skip_to_next_round", label: "skip" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2, selected_option_numbers: [2, 1] });
  });

  it("task_timeout_resume은 resume 옵션을 우선 선택한다", () => {
    const payload = buildYoloDecisionReplyPayload(
      createItem({
        id: "decision-timeout",
        kind: "task_timeout_resume",
        task_id: "task-timeout",
        task_title: "Task timeout",
        options: [
          { number: 1, action: "keep_inbox", label: "Keep" },
          { number: 2, action: "resume_timeout_task", label: "Resume" },
        ],
      }),
    );
    expect(payload).toEqual({ option_number: 2 });
  });
});

describe("runYoloDecisionAutopilot", () => {
  it("project 대표선택 -> 회의시작까지 연속 자동 진행한다", async () => {
    const selected = new Set<string>();
    let started = false;

    const getDecisionInboxItems = (): DecisionInboxRouteItem[] => {
      if (started) return [];
      if (selected.size < 2) {
        const options = [
          !selected.has("task-a") ? { number: 1, action: "approve_task_review:task-a", label: "A" } : null,
          !selected.has("task-b") ? { number: 2, action: "approve_task_review:task-b", label: "B" } : null,
          { number: 3, action: "add_followup_request", label: "Follow-up" },
        ].filter(Boolean) as Array<{ number: number; action: string; label: string }>;

        return [
          createItem({
            id: "project-review-ready:1",
            kind: "project_review_ready",
            options,
          }),
        ];
      }

      return [
        createItem({
          id: "project-review-ready:1",
          kind: "project_review_ready",
          options: [
            { number: 1, action: "start_project_review", label: "Start" },
            { number: 2, action: "add_followup_request", label: "Follow-up" },
          ],
        }),
      ];
    };

    const applyDecisionReply = async (
      decisionId: string,
      body: Record<string, unknown>,
    ): Promise<DecisionApplyResult> => {
      expect(decisionId).toBe("project-review-ready:1");
      const option = Number(body.option_number);
      if (option === 1 && selected.size < 2) {
        selected.add("task-a");
        return { status: 200, payload: { ok: true, resolved: false } };
      }
      if (option === 2 && selected.size < 2) {
        selected.add("task-b");
        return { status: 200, payload: { ok: true, resolved: false } };
      }
      if (option === 1 && selected.size >= 2) {
        started = true;
        return { status: 200, payload: { ok: true, resolved: true } };
      }
      return { status: 400, payload: { error: "unexpected_option" } };
    };

    const applied = await runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 10,
    });

    expect(applied).toBe(3);
    expect(selected.size).toBe(2);
    expect(started).toBe(true);
  });

  it("일시적 409 오류(project_not_ready_for_review_meeting)는 같은 사이클에서 재시도한다", async () => {
    let attempts = 0;
    let resolved = false;
    const getDecisionInboxItems = (): DecisionInboxRouteItem[] =>
      resolved
        ? []
        : [
            createItem({
              id: "project-review-ready:retry",
              kind: "project_review_ready",
              options: [{ number: 1, action: "start_project_review", label: "Start" }],
            }),
          ];

    const applyDecisionReply = async (): Promise<DecisionApplyResult> => {
      attempts += 1;
      if (attempts < 3) {
        return { status: 409, payload: { error: "project_not_ready_for_review_meeting" } };
      }
      resolved = true;
      return { status: 200, payload: { ok: true, resolved: true } };
    };

    const applied = await runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 5,
    });

    expect(attempts).toBe(3);
    expect(applied).toBe(1);
  });

  it("shouldSkipItem=true 인 항목은 자동 의사결정에서 제외한다", async () => {
    let attempts = 0;
    const getDecisionInboxItems = (): DecisionInboxRouteItem[] => [
      createItem({
        id: "video-review",
        kind: "project_review_ready",
        options: [{ number: 1, action: "start_project_review", label: "Start" }],
      }),
    ];

    const applyDecisionReply = async (): Promise<DecisionApplyResult> => {
      attempts += 1;
      return { status: 200, payload: { ok: true } };
    };

    const applied = await runYoloDecisionAutopilot({
      getDecisionInboxItems,
      applyDecisionReply,
      maxSteps: 3,
      shouldSkipItem: () => true,
    });

    expect(applied).toBe(0);
    expect(attempts).toBe(0);
  });
});
