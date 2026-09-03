import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { resolveDirectiveLeaderCandidateScope } from "./directive-leader-scope.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      default_pack_key TEXT NOT NULL DEFAULT 'development',
      assignment_mode TEXT NOT NULL DEFAULT 'auto'
    );

    CREATE TABLE project_agents (
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      department_id TEXT
    );
  `);
  return db;
}

function sorted(values: string[] | null): string[] | null {
  return Array.isArray(values) ? [...values].sort() : null;
}

describe("resolveDirectiveLeaderCandidateScope", () => {
  it("활성 오피스팩(비 development)이 있으면 프로젝트 기본팩보다 우선한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "video_preprod");
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
          novel: {
            departments: [{ id: "planning" }, { id: "design" }],
            agents: [
              { id: "novel-seed-1", department_id: "planning" },
              { id: "novel-seed-2", department_id: "design" },
            ],
          },
        }),
      );

      db.prepare("INSERT INTO projects (id, default_pack_key, assignment_mode) VALUES (?, ?, 'auto')").run(
        "proj-1",
        "novel",
      );

      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("planning-global", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("video_preprod-seed-1", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("video_preprod-seed-2", "dev");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("novel-seed-1", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("novel-seed-2", "design");

      const scope = resolveDirectiveLeaderCandidateScope(db, "proj-1");
      expect(sorted(scope)).toEqual(sorted(["video_preprod-seed-1"]));
      expect(scope).not.toContain("planning-global");
      expect(scope).not.toContain("novel-seed-1");
      const devScope = resolveDirectiveLeaderCandidateScope(db, "proj-1", "dev");
      expect(sorted(devScope)).toEqual(sorted(["video_preprod-seed-2"]));
    } finally {
      db.close();
    }
  });

  it("활성 오피스팩이 development면 프로젝트 기본팩 스코프를 사용한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "officePackProfiles",
        JSON.stringify({
          novel: {
            departments: [{ id: "planning" }, { id: "design" }],
            agents: [
              { id: "novel-seed-1", department_id: "planning" },
              { id: "novel-seed-2", department_id: "design" },
            ],
          },
        }),
      );
      db.prepare("INSERT INTO projects (id, default_pack_key, assignment_mode) VALUES (?, ?, 'auto')").run(
        "proj-2",
        "novel",
      );

      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("planning-global", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("novel-seed-1", "planning");
      db.prepare("INSERT INTO agents (id, department_id) VALUES (?, ?)").run("novel-seed-2", "design");

      const scope = resolveDirectiveLeaderCandidateScope(db, "proj-2");
      expect(sorted(scope)).toEqual(sorted(["novel-seed-1"]));
      expect(scope).not.toContain("planning-global");
      const designScope = resolveDirectiveLeaderCandidateScope(db, "proj-2", "design");
      expect(sorted(designScope)).toEqual(sorted(["novel-seed-2"]));
    } finally {
      db.close();
    }
  });

  it("활성 오피스팩/프로젝트 스코프가 없으면 null을 반환한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("officeWorkflowPack", "development");
      const scope = resolveDirectiveLeaderCandidateScope(db, null);
      expect(scope).toBeNull();
    } finally {
      db.close();
    }
  });
});
