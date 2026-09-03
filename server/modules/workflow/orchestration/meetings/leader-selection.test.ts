import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createMeetingLeaderSelectionTools } from "./leader-selection.ts";

type AgentRow = {
  id: string;
  name: string;
  name_ko: string;
  role: string;
  personality: string | null;
  status: string;
  department_id: string | null;
  current_task_id: string | null;
  avatar_emoji: string;
  cli_provider: string | null;
  oauth_account_id: string | null;
  api_provider_id: string | null;
  api_model: string | null;
  cli_model: string | null;
  cli_reasoning_level: string | null;
};

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      personality TEXT,
      status TEXT NOT NULL,
      department_id TEXT,
      current_task_id TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      cli_provider TEXT,
      oauth_account_id TEXT,
      api_provider_id TEXT,
      api_model TEXT,
      cli_model TEXT,
      cli_reasoning_level TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      department_id TEXT,
      project_id TEXT,
      workflow_pack_key TEXT
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      target_department_id TEXT
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      assignment_mode TEXT NOT NULL DEFAULT 'auto'
    );

    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );
  `);

  return db;
}

function insertLeader(db: DatabaseSync, input: { id: string; dept: string; name?: string; status?: string }): void {
  db.prepare(
    `
      INSERT INTO agents (
        id, name, name_ko, role, personality, status, department_id, current_task_id,
        avatar_emoji, cli_provider, oauth_account_id, api_provider_id, api_model, cli_model, cli_reasoning_level, created_at
      ) VALUES (?, ?, ?, 'team_leader', NULL, ?, ?, NULL, '🤖', 'codex', NULL, NULL, NULL, NULL, NULL, 1)
    `,
  ).run(input.id, input.name ?? input.id, input.name ?? input.id, input.status ?? "idle", input.dept);
}

function buildFindTeamLeader(db: DatabaseSync) {
  return (departmentId: string, candidateAgentIds?: string[] | null): AgentRow | null => {
    if (!departmentId) return null;
    if (Array.isArray(candidateAgentIds)) {
      if (candidateAgentIds.length === 0) return null;
      const placeholders = candidateAgentIds.map(() => "?").join(",");
      return (
        (db
          .prepare(
            `
            SELECT *
            FROM agents
            WHERE department_id = ?
              AND role = 'team_leader'
              AND id IN (${placeholders})
            ORDER BY created_at ASC
            LIMIT 1
          `,
          )
          .get(departmentId, ...candidateAgentIds) as AgentRow | undefined) ?? null
      );
    }
    return (
      (db
        .prepare(
          `
          SELECT *
          FROM agents
          WHERE department_id = ? AND role = 'team_leader'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get(departmentId) as AgentRow | undefined) ?? null
    );
  };
}

describe("meeting leader selection - office pack scope", () => {
  it("video_preprod task review leader 선정 시 동일 팩 리더만 참여한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO departments (id, sort_order) VALUES ('planning', 1), ('dev', 2)").run();

      insertLeader(db, { id: "planning-global", dept: "planning" });
      insertLeader(db, { id: "dev-global", dept: "dev" });
      insertLeader(db, { id: "video_preprod-seed-1", dept: "planning" });
      insertLeader(db, { id: "video_preprod-seed-2", dept: "dev" });

      db.prepare(
        "INSERT INTO tasks (id, title, description, department_id, project_id, workflow_pack_key) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("task-video", "video task", "make storyboard", "planning", null, "video_preprod");

      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning" }, { id: "dev" }],
            agents: [
              { id: "video_preprod-seed-1", department_id: "planning" },
              { id: "video_preprod-seed-2", department_id: "dev" },
            ],
          },
        }),
      );

      const tools = createMeetingLeaderSelectionTools({
        db,
        findTeamLeader: buildFindTeamLeader(db),
        detectTargetDepartments: () => [],
      });

      const leaders = tools.getTaskReviewLeaders("task-video", "planning", {
        minLeaders: 2,
        includePlanning: true,
        fallbackAll: true,
      });
      const leaderIds = leaders.map((leader) => leader.id);

      expect(leaderIds).toContain("video_preprod-seed-1");
      expect(leaderIds).toContain("video_preprod-seed-2");
      expect(leaderIds).not.toContain("planning-global");
      expect(leaderIds).not.toContain("dev-global");
    } finally {
      db.close();
    }
  });

  it("manual 배정이어도 관련부서/팩 범위 팀장을 회의에 포함한다", () => {
    const db = setupDb();
    try {
      db.prepare(
        "INSERT INTO departments (id, sort_order) VALUES ('planning', 1), ('dev', 2), ('design', 3), ('qa', 4)",
      ).run();

      // global leaders (must not be picked when pack scope is available)
      insertLeader(db, { id: "planning-global", dept: "planning" });
      insertLeader(db, { id: "dev-global", dept: "dev" });
      insertLeader(db, { id: "design-global", dept: "design" });

      // video pack leaders
      insertLeader(db, { id: "video_preprod-seed-1", dept: "planning" });
      insertLeader(db, { id: "video_preprod-seed-2", dept: "dev" });
      insertLeader(db, { id: "video_preprod-seed-3", dept: "design" });

      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          video_preprod: {
            departments: [{ id: "planning" }, { id: "dev" }, { id: "design" }],
            agents: [
              { id: "video_preprod-seed-1", department_id: "planning" },
              { id: "video_preprod-seed-2", department_id: "dev" },
              { id: "video_preprod-seed-3", department_id: "design" },
            ],
          },
        }),
      );

      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES (?, 'manual')").run("proj-manual");
      // Manual project with only planning leader assigned
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run(
        "proj-manual",
        "video_preprod-seed-1",
      );

      db.prepare(
        "INSERT INTO tasks (id, title, description, department_id, project_id, workflow_pack_key) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        "task-manual-video",
        "영상 프리프로덕션 킥오프",
        "콘티/씬 설계 보강 필요",
        "planning",
        "proj-manual",
        "video_preprod",
      );

      const tools = createMeetingLeaderSelectionTools({
        db,
        findTeamLeader: buildFindTeamLeader(db),
        detectTargetDepartments: () => ["design", "dev"],
      });

      const leaders = tools.getTaskReviewLeaders("task-manual-video", "planning", {
        minLeaders: 2,
        includePlanning: true,
        fallbackAll: true,
      });
      const leaderIds = leaders.map((leader) => leader.id);

      expect(leaderIds).toContain("video_preprod-seed-1");
      expect(leaderIds).toContain("video_preprod-seed-2");
      expect(leaderIds).toContain("video_preprod-seed-3");
      expect(leaderIds).not.toContain("planning-global");
      expect(leaderIds).not.toContain("dev-global");
      expect(leaderIds).not.toContain("design-global");
    } finally {
      db.close();
    }
  });
});
