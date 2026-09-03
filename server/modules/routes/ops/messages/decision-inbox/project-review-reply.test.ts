import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { handleProjectReviewDecisionReply } from "./project-review-reply.ts";
import type { DecisionInboxRouteItem, DecisionOption, ProjectReviewReplyDeps } from "./types.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL,
      workflow_pack_key TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      department_id TEXT,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
    );

    CREATE TABLE task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT,
      target_department_id TEXT,
      created_at INTEGER
    );
  `);
  return db;
}

function createBaseInput(db: DatabaseSync, overrides?: Partial<ProjectReviewReplyDeps>) {
  let ts = 1000;
  const nowMs = () => {
    ts += 1;
    return ts;
  };
  const appendTaskLog = (taskId: string, kind: string, message: string) => {
    db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, ?, ?, ?)").run(
      taskId,
      kind,
      message,
      nowMs(),
    );
  };
  const deps: ProjectReviewReplyDeps = {
    db,
    appendTaskLog,
    nowMs,
    normalizeTextField: (value: unknown) => {
      const text = String(value ?? "").trim();
      return text || null;
    },
    getPreferredLanguage: () => "ko",
    pickL: (pool: any) => (Array.isArray(pool?.ko) ? pool.ko[0] : ""),
    l: (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => ({
      ko,
      en,
      ja: ja ?? [],
      zh: zh ?? [],
      de: de ?? [],
    }),
    broadcast: vi.fn(),
    finishReview: vi.fn(),
    getProjectReviewDecisionState: () => ({ snapshot_hash: "snap-1" }) as any,
    recordProjectReviewDecisionEvent: vi.fn(),
    getProjectReviewTaskChoices: () => [],
    openSupplementRound: vi.fn(async () => ({ started: false, reason: "not_used" })),
    processSubtaskDelegations: vi.fn(),
    PROJECT_REVIEW_TASK_SELECTED_LOG_PREFIX: "Decision inbox: project review task option selected",
    ...overrides,
  };

  const currentItem: DecisionInboxRouteItem = {
    id: "project-review-ready:proj-1",
    kind: "project_review_ready",
    created_at: 1000,
    summary: "summary",
    project_id: "proj-1",
    project_name: "Project 1",
    project_path: "/tmp/project1",
    task_id: null,
    task_title: null,
    options: [
      {
        number: 1,
        action: "start_project_review",
        label: "팀장 회의 진행",
      },
    ],
  };

  const selectedOption: DecisionOption = currentItem.options[0] as DecisionOption;
  const resPayload: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null };
  const res = {
    status(code: number) {
      resPayload.status = code;
      return this;
    },
    json(value: Record<string, unknown>) {
      resPayload.body = value;
      return this;
    },
  } as any;

  return {
    deps,
    req: { body: {} } as any,
    res,
    resPayload,
    currentItem,
    selectedOption,
  };
}

describe("project review reply", () => {
  it("start_project_review에서 hold 로그가 감지되면 blocked 응답을 반환한다", async () => {
    const db = createDb();
    try {
      db.prepare(
        `
          INSERT INTO tasks (id, title, project_id, status, workflow_pack_key, source_task_id, created_at, updated_at)
          VALUES ('task-1', '영상 최종 검토', 'proj-1', 'review', 'video_preprod', NULL, 1, 1)
        `,
      ).run();

      const input = createBaseInput(db);
      const { deps, req, res, resPayload, currentItem, selectedOption } = input;
      deps.finishReview = vi.fn((taskId: string) => {
        db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, 3000)").run(
          taskId,
          "Review hold: video artifact gate blocked approval (missing/empty video file). checked=/tmp/video_output/final.mp4",
        );
      });

      const handled = await handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber: 1,
        deps,
      });

      expect(handled).toBe(true);
      expect(resPayload.status).toBe(200);
      expect(resPayload.body).toMatchObject({
        ok: true,
        resolved: false,
        action: "start_project_review_blocked",
      });
      const blockedTasks = (resPayload.body?.blocked_tasks as Array<{ reason?: string }> | undefined) ?? [];
      expect(blockedTasks).toHaveLength(1);
      expect(blockedTasks[0]?.reason).toBe("video_artifact_missing");
      const renderSubtasks = db
        .prepare("SELECT title, target_department_id, status FROM subtasks WHERE task_id = 'task-1'")
        .all() as Array<{ title: string; target_department_id: string | null; status: string }>;
      expect(renderSubtasks).toHaveLength(1);
      expect(renderSubtasks[0]).toMatchObject({
        title: "[VIDEO_FINAL_RENDER] 최종 영상 렌더링",
        target_department_id: "dev",
        status: "pending",
      });
      expect((deps.recordProjectReviewDecisionEvent as any).mock.calls[0]?.[0]?.event_type).toBe(
        "start_review_meeting_blocked",
      );
    } finally {
      db.close();
    }
  });

  it("start_project_review에서 hold 없이 진행되면 resolved=true로 완료된다", async () => {
    const db = createDb();
    try {
      db.prepare(
        `
          INSERT INTO tasks (id, title, project_id, status, workflow_pack_key, source_task_id, created_at, updated_at)
          VALUES ('task-1', '영상 최종 검토', 'proj-1', 'review', 'video_preprod', NULL, 1, 1)
        `,
      ).run();

      const input = createBaseInput(db);
      const { deps, req, res, resPayload, currentItem, selectedOption } = input;
      deps.finishReview = vi.fn((taskId: string) => {
        db.prepare("UPDATE tasks SET status = 'done', updated_at = 4000 WHERE id = ?").run(taskId);
      });

      const handled = await handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber: 1,
        deps,
      });

      expect(handled).toBe(true);
      expect(resPayload.status).toBe(200);
      expect(resPayload.body).toMatchObject({
        ok: true,
        resolved: true,
        action: "start_project_review",
      });
      expect((resPayload.body?.started_task_ids as string[] | undefined) ?? []).toEqual(["task-1"]);
      expect((deps.recordProjectReviewDecisionEvent as any).mock.calls[0]?.[0]?.event_type).toBe(
        "start_review_meeting",
      );
    } finally {
      db.close();
    }
  });

  it("VIDEO_FINAL_RENDER done 서브태스크가 이미 있으면 blocked 시 신규 생성하지 않는다", async () => {
    const db = createDb();
    try {
      db.prepare(
        `
          INSERT INTO tasks (id, title, project_id, status, workflow_pack_key, source_task_id, created_at, updated_at)
          VALUES ('task-1', '영상 최종 검토', 'proj-1', 'review', 'video_preprod', NULL, 1, 1)
        `,
      ).run();
      db.prepare(
        `
          INSERT INTO subtasks (id, task_id, title, description, status, target_department_id, created_at)
          VALUES ('st-render-done', 'task-1', '[VIDEO_FINAL_RENDER] 최종 영상 렌더링', 'done render', 'done', 'dev', 2000)
        `,
      ).run();

      const input = createBaseInput(db);
      const { deps, req, res, resPayload, currentItem, selectedOption } = input;
      deps.finishReview = vi.fn((taskId: string) => {
        db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, 3000)").run(
          taskId,
          "Review hold: video artifact gate blocked approval (missing/empty video file). checked=/tmp/video_output/final.mp4",
        );
      });

      const handled = await handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber: 1,
        deps,
      });

      expect(handled).toBe(true);
      expect(resPayload.status).toBe(200);
      expect(resPayload.body).toMatchObject({
        ok: true,
        resolved: false,
        action: "start_project_review_blocked",
      });
      const renderSubtasks = db
        .prepare(
          "SELECT id, title, target_department_id, status FROM subtasks WHERE task_id = 'task-1' ORDER BY created_at ASC",
        )
        .all() as Array<{ id: string; title: string; target_department_id: string | null; status: string }>;
      expect(renderSubtasks).toHaveLength(1);
      expect(renderSubtasks[0]).toMatchObject({
        id: "st-render-done",
        title: "[VIDEO_FINAL_RENDER] 최종 영상 렌더링",
        target_department_id: "dev",
        status: "done",
      });
      expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("위임 prefix가 붙은 VIDEO_FINAL_RENDER 서브태스크가 있으면 신규 생성하지 않는다", async () => {
    const db = createDb();
    try {
      db.prepare(
        `
          INSERT INTO tasks (id, title, project_id, status, workflow_pack_key, source_task_id, created_at, updated_at)
          VALUES ('task-1', '영상 최종 검토', 'proj-1', 'review', 'video_preprod', NULL, 1, 1)
        `,
      ).run();
      db.prepare(
        `
          INSERT INTO subtasks (id, task_id, title, description, status, target_department_id, created_at)
          VALUES ('st-render-prefixed', 'task-1', '[서브태스크 일괄협업 x1] [VIDEO_FINAL_RENDER] 최종 영상 렌더링', 'delegated render', 'blocked', 'dev', 2000)
        `,
      ).run();

      const input = createBaseInput(db);
      const { deps, req, res, resPayload, currentItem, selectedOption } = input;
      deps.finishReview = vi.fn((taskId: string) => {
        db.prepare("INSERT INTO task_logs (task_id, kind, message, created_at) VALUES (?, 'system', ?, 3000)").run(
          taskId,
          "Review hold: VIDEO_FINAL_RENDER already delegated, waiting for completion.",
        );
      });

      const handled = await handleProjectReviewDecisionReply({
        req,
        res,
        currentItem,
        selectedOption,
        optionNumber: 1,
        deps,
      });

      expect(handled).toBe(true);
      expect(resPayload.status).toBe(200);
      expect(resPayload.body).toMatchObject({
        ok: true,
        resolved: false,
        action: "start_project_review_blocked",
      });
      const renderSubtasks = db
        .prepare(
          "SELECT id, title, target_department_id, status FROM subtasks WHERE task_id = 'task-1' ORDER BY created_at ASC",
        )
        .all() as Array<{ id: string; title: string; target_department_id: string | null; status: string }>;
      expect(renderSubtasks).toHaveLength(1);
      expect(renderSubtasks[0]).toMatchObject({
        id: "st-render-prefixed",
        target_department_id: "dev",
        status: "blocked",
      });
      expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
