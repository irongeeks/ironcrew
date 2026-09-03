import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { resolveConstrainedAgentScopeForTask, selectAutoAssignableAgentForTask } from "./execution-run-auto-assign.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '🏢',
      color TEXT NOT NULL DEFAULT '#64748b',
      description TEXT,
      prompt TEXT,
      sort_order INTEGER NOT NULL DEFAULT 99,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT '',
      department_id TEXT,
      role TEXT NOT NULL,
      cli_provider TEXT,
      oauth_account_id TEXT,
      avatar_emoji TEXT NOT NULL DEFAULT '🤖',
      personality TEXT,
      status TEXT NOT NULL,
      current_task_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE oauth_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL
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

function insertAgent(
  db: DatabaseSync,
  input: {
    id: string;
    name: string;
    department_id: string | null;
    role?: string;
    cli_provider?: string | null;
    oauth_account_id?: string | null;
    status?: string;
    current_task_id?: string | null;
    created_at?: number;
  },
): void {
  db.prepare(
    `
      INSERT INTO agents (
        id, name, department_id, role, cli_provider, oauth_account_id, status, current_task_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.id,
    input.name,
    input.department_id,
    input.role ?? "senior",
    input.cli_provider ?? "codex",
    input.oauth_account_id ?? null,
    input.status ?? "idle",
    input.current_task_id ?? null,
    input.created_at ?? 1,
  );
}

describe("selectAutoAssignableAgentForTask", () => {
  it("오피스팩별 우선 부서가 다르게 적용된다", () => {
    const db = setupDb();
    try {
      insertAgent(db, { id: "agent-plan", name: "Planner", department_id: "planning", created_at: 1 });
      insertAgent(db, { id: "agent-dev", name: "Dev", department_id: "dev", created_at: 2 });
      insertAgent(db, { id: "agent-design", name: "Designer", department_id: "design", created_at: 3 });

      const devSelected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "development",
        department_id: null,
        project_id: null,
      });
      const researchSelected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "web_research_report",
        department_id: null,
        project_id: null,
      });
      const videoSelected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "video_preprod",
        department_id: null,
        project_id: null,
      });

      expect(devSelected?.agent.department_id).toBe("dev");
      expect(researchSelected?.agent.department_id).toBe("dev");
      expect(videoSelected?.agent.department_id).toBe("design");
    } finally {
      db.close();
    }
  });

  it("팩 우선 부서 순서로 자동 배정 대상을 고른다", () => {
    const db = setupDb();
    try {
      insertAgent(db, { id: "agent-dev", name: "Dev", department_id: "dev", created_at: 1 });
      insertAgent(db, { id: "agent-plan", name: "Planner", department_id: "planning", created_at: 2 });

      // design_studio priorities: design > qa > planning > dev — with only dev+planning, planning wins
      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "design_studio",
        department_id: null,
        project_id: null,
      });

      expect(selected?.packKey).toBe("design_studio");
      expect(selected?.agent.id).toBe("agent-plan");
    } finally {
      db.close();
    }
  });

  it("프로젝트 manual 모드에서는 지정 인원 범위로만 자동 배정한다", () => {
    const db = setupDb();
    try {
      insertAgent(db, { id: "agent-plan", name: "Planner", department_id: "planning", created_at: 1 });
      insertAgent(db, { id: "agent-qa", name: "QA", department_id: "qa", created_at: 2 });
      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES (?, ?)").run("project-1", "manual");
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run("project-1", "agent-qa");

      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "web_research_report",
        department_id: null,
        project_id: "project-1",
      });

      expect(selected?.agent.id).toBe("agent-qa");
    } finally {
      db.close();
    }
  });

  it("선호 부서가 비어있으면 전체 idle/break 인원으로 폴백한다", () => {
    const db = setupDb();
    try {
      insertAgent(db, {
        id: "agent-dev-working",
        name: "Busy Dev",
        department_id: "dev",
        status: "working",
        current_task_id: "task-busy",
        created_at: 1,
      });
      insertAgent(db, {
        id: "agent-qa-idle",
        name: "Idle QA",
        department_id: "qa",
        status: "idle",
        created_at: 2,
      });

      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "web_research_report",
        department_id: null,
        project_id: null,
      });

      expect(selected?.agent.id).toBe("agent-qa-idle");
    } finally {
      db.close();
    }
  });

  it("브라우저 provider 에이전트도 자동 배정 대상으로 선택된다", () => {
    const db = setupDb();
    try {
      insertAgent(db, {
        id: "agent-browser",
        name: "Browser QA",
        department_id: "browser",
        cli_provider: "browser",
        created_at: 1,
      });

      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "development",
        department_id: null,
        project_id: null,
      });

      expect(selected?.agent.id).toBe("agent-browser");
      expect(selected?.agent.cli_provider).toBe("browser");
    } finally {
      db.close();
    }
  });

  it("워크팩 프로필 에이전트가 있으면 런타임 후보를 해당 프로필로 제한한다", () => {
    const db = setupDb();
    try {
      insertAgent(db, { id: "dsn-pack-agent", name: "Design Pack Agent", department_id: "design", created_at: 0 });
      insertAgent(db, { id: "agent-global-design", name: "Global Designer", department_id: "design", created_at: 1 });
      insertAgent(db, { id: "agent-global-dev", name: "Global Dev", department_id: "dev", created_at: 2 });
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          design_studio: {
            departments: [
              {
                id: "design",
                name: "Design",
                name_ko: "디자인팀",
                name_ja: "デザインチーム",
                name_zh: "设计组",
                icon: "🎨",
                color: "#8b5cf6",
                sort_order: 3,
                created_at: 1,
              },
            ],
            agents: [
              {
                id: "dsn-pack-agent",
                name: "Design Pack Agent",
                name_ko: "디자인팩 에이전트",
                name_ja: "デザインパックエージェント",
                name_zh: "设计包代理",
                department_id: "design",
                role: "senior",
                cli_provider: "codex",
                avatar_emoji: "🧪",
                created_at: 5,
              },
            ],
          },
        }),
      );

      const scope = resolveConstrainedAgentScopeForTask(db, {
        workflow_pack_key: "design_studio",
        department_id: null,
        project_id: null,
      });
      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "design_studio",
        department_id: null,
        project_id: null,
      });

      expect(scope).toEqual(["dsn-pack-agent"]);
      expect(selected?.agent.id).toBe("dsn-pack-agent");
    } finally {
      db.close();
    }
  });

  it("없는 프로필 에이전트는 전역 agents 테이블에 자동 생성하지 않는다", () => {
    const db = setupDb();
    try {
      insertAgent(db, { id: "agent-global-design", name: "Global Designer", department_id: "design", created_at: 1 });
      insertAgent(db, { id: "agent-global-dev", name: "Global Dev", department_id: "dev", created_at: 2 });
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          novel: {
            departments: [],
            agents: [
              {
                id: "missing-pack-agent",
                name: "Missing Pack Agent",
                name_ko: "미싱 팩 에이전트",
                name_ja: "未登録パックエージェント",
                name_zh: "缺失包代理",
                department_id: "design",
                role: "senior",
                cli_provider: "codex",
                avatar_emoji: "🧪",
                created_at: 5,
              },
            ],
          },
        }),
      );

      const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
      const scope = resolveConstrainedAgentScopeForTask(db, {
        workflow_pack_key: "novel",
        department_id: null,
        project_id: null,
      });
      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "novel",
        department_id: null,
        project_id: null,
      });
      const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;

      expect(scope).toEqual(["agent-global-design"]);
      expect(afterCount).toBe(beforeCount);
      expect(selected?.agent.id).toBe("agent-global-design");
    } finally {
      db.close();
    }
  });

  it("manual 프로젝트면 워크팩 프로필과 manual 범위를 교집합으로 제한한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          report: {
            departments: [],
            agents: [
              { id: "pack-a", name: "Pack A", department_id: "planning", role: "senior", cli_provider: "codex" },
              { id: "pack-b", name: "Pack B", department_id: "planning", role: "senior", cli_provider: "codex" },
            ],
          },
        }),
      );
      insertAgent(db, { id: "pack-a", name: "Pack A", department_id: "planning", created_at: 1 });
      insertAgent(db, { id: "pack-b", name: "Pack B", department_id: "planning", created_at: 2 });
      db.prepare("INSERT INTO projects (id, assignment_mode) VALUES (?, ?)").run("project-1", "manual");
      db.prepare("INSERT INTO project_agents (project_id, agent_id) VALUES (?, ?)").run("project-1", "pack-b");

      const scope = resolveConstrainedAgentScopeForTask(db, {
        workflow_pack_key: "report",
        department_id: null,
        project_id: "project-1",
      });
      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "report",
        department_id: null,
        project_id: "project-1",
      });

      expect(scope).toEqual(["pack-b"]);
      expect(selected?.agent.id).toBe("pack-b");
    } finally {
      db.close();
    }
  });

  it("copilot 계정이 없으면 OAuth 없는 provider를 건너뛰고 다른 후보를 선택한다", () => {
    const db = setupDb();
    try {
      insertAgent(db, {
        id: "agent-copilot",
        name: "Copilot Agent",
        department_id: "dev",
        cli_provider: "copilot",
        created_at: 1,
      });
      insertAgent(db, {
        id: "agent-codex",
        name: "Codex Agent",
        department_id: "planning",
        cli_provider: "codex",
        created_at: 2,
      });

      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "web_research_report",
        department_id: null,
        project_id: null,
      });

      expect(selected?.agent.id).toBe("agent-codex");
    } finally {
      db.close();
    }
  });

  it("copilot 활성 계정이 있으면 copilot 후보를 정상 선택한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO oauth_accounts (id, provider, status) VALUES (?, ?, ?)").run(
        "oauth-gh-1",
        "github",
        "active",
      );

      insertAgent(db, {
        id: "agent-copilot",
        name: "Copilot Agent",
        department_id: "dev",
        cli_provider: "copilot",
        oauth_account_id: "oauth-gh-1",
        created_at: 1,
      });
      insertAgent(db, {
        id: "agent-codex",
        name: "Codex Agent",
        department_id: "planning",
        cli_provider: "codex",
        created_at: 2,
      });

      const selected = selectAutoAssignableAgentForTask(db, {
        workflow_pack_key: "web_research_report",
        department_id: null,
        project_id: null,
      });

      expect(selected?.agent.id).toBe("agent-copilot");
    } finally {
      db.close();
    }
  });
});
