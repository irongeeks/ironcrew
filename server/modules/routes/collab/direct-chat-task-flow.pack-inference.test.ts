import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createDirectTaskFlow } from "./direct-chat-task-flow.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      assigned_agent_id TEXT,
      project_id TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      workflow_pack_key TEXT NOT NULL,
      project_path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      current_task_id TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      core_goal TEXT,
      project_path TEXT,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      last_used_at INTEGER,
      updated_at INTEGER
    );
  `);
  db.prepare("INSERT INTO projects (id, name, core_goal, project_path, default_pack_key) VALUES (?, ?, ?, ?, ?)").run(
    "project-1",
    "Demo",
    "goal",
    "/tmp/demo",
    "development",
  );
  return db;
}

describe("direct-chat task flow pack inference", () => {
  it("seed 에이전트 ID로 workflow pack을 우선 고정한다", async () => {
    const db = setupDb();
    try {
      const flow = createDirectTaskFlow({
        db: db as any,
        nowMs: () => 1000,
        randomDelay: () => 0,
        broadcast: () => {},
        appendTaskLog: () => {},
        recordTaskCreationAudit: () => {},
        resolveLang: () => "ko",
        detectProjectPath: () => null,
        normalizeTextField: (value: unknown) => (typeof value === "string" ? value.trim() || null : null),
        resolveProjectFromOptions: () => ({
          id: "project-1",
          name: "Demo",
          projectPath: "/tmp/demo",
          coreGoal: "goal",
        }),
        buildRoundGoal: () => "round",
        getDeptName: () => "기획팀",
        l: (ko: string[], en: string[], ja?: string[], zh?: string[], de?: string[]) => ({
          ko,
          en,
          ja: ja ?? en,
          zh: zh ?? en,
          de: de ?? en,
        }),
        pickL: (pool: any) => pool.ko[0],
        registerTaskMessengerRoute: () => {},
        isTaskWorkflowInterrupted: () => false,
        startTaskExecutionForAgent: () => {},
        handleTaskDelegation: () => {},
        sendInCharacterAutoMessage: () => {},
      });

      flow.createDirectAgentTaskAndRun(
        {
          id: "video_preprod-seed-1",
          name: "Rian",
          name_ko: "리안",
          role: "team_leader",
          personality: null,
          status: "idle",
          department_id: "planning",
          current_task_id: null,
          avatar_emoji: "🎬",
          cli_provider: "claude",
          oauth_account_id: null,
          api_provider_id: null,
          api_model: null,
          cli_model: null,
          cli_reasoning_level: null,
          cli_profile: null,
        },
        "영상 기획안 만들어줘",
        { projectId: "project-1" },
      );

      const row = db.prepare("SELECT workflow_pack_key FROM tasks ORDER BY created_at DESC LIMIT 1").get() as {
        workflow_pack_key: string;
      };
      expect(row.workflow_pack_key).toBe("video_preprod");
    } finally {
      db.close();
    }
  });
});
