import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createPromptSkillsHelper } from "./prompt-skills.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE skill_learning_history (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      provider TEXT,
      repo TEXT,
      skill_id TEXT,
      skill_label TEXT,
      status TEXT,
      command TEXT,
      error TEXT,
      run_started_at INTEGER,
      run_completed_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
  return db;
}

function insertLearnedSkill(
  db: DatabaseSync,
  input: { provider: string; repo: string; skillId: string; skillLabel: string; at: number },
): void {
  db.prepare(
    `
      INSERT INTO skill_learning_history (
        id, job_id, provider, repo, skill_id, skill_label,
        status, command, error, run_started_at, run_completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', '', NULL, ?, ?, ?, ?)
    `,
  ).run(
    `${input.provider}-${input.skillId}`,
    `job-${input.provider}-${input.skillId}`,
    input.provider,
    input.repo,
    input.skillId,
    input.skillLabel,
    input.at,
    input.at,
    input.at,
    input.at,
  );
}

describe("createPromptSkillsHelper", () => {
  it("provider 학습 스킬을 우선 노출하고 MCP/글로벌 규칙을 포함한다", () => {
    const db = createDb();
    try {
      insertLearnedSkill(db, {
        provider: "codex",
        repo: "acme/skills",
        skillId: "planner",
        skillLabel: "acme/skills#planner",
        at: 100,
      });
      insertLearnedSkill(db, {
        provider: "gemini",
        repo: "global/skills",
        skillId: "writer",
        skillLabel: "global/skills#writer",
        at: 90,
      });

      const { buildAvailableSkillsPromptBlock } = createPromptSkillsHelper(db);
      const block = buildAvailableSkillsPromptBlock("codex");

      expect(block).toContain("[scope=provider]");
      expect(block).toContain("acme/skills#planner");
      expect(block).toContain("[scope=global]");
      expect(block).toContain("[MCP Rule]");
      expect(block).toContain("globally installed skills");
      expect(block).not.toContain("tools/taste-skill/skill.md");
      expect(block).not.toContain("default=taste-skill");
    } finally {
      db.close();
    }
  });

  it("provider 학습 스킬이 없으면 global 학습 스킬을 사용한다", () => {
    const db = createDb();
    try {
      insertLearnedSkill(db, {
        provider: "gemini",
        repo: "global/skills",
        skillId: "report",
        skillLabel: "global/skills#report",
        at: 100,
      });

      const { buildAvailableSkillsPromptBlock } = createPromptSkillsHelper(db);
      const block = buildAvailableSkillsPromptBlock("codex");

      expect(block).not.toContain("[scope=provider]");
      expect(block).toContain("[scope=global]");
      expect(block).toContain("global/skills#report");
      expect(block).toContain("[MCP Rule]");
    } finally {
      db.close();
    }
  });

  it("학습 이력이 없으면 empty 안내를 반환한다", () => {
    const db = createDb();
    try {
      const { buildAvailableSkillsPromptBlock } = createPromptSkillsHelper(db);
      const block = buildAvailableSkillsPromptBlock("codex");

      expect(block).toContain("[empty][none]");
      expect(block).toContain("No learned skills recorded in DB yet");
      expect(block).toContain("[MCP Rule]");
    } finally {
      db.close();
    }
  });
});
