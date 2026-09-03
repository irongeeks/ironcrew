import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeCollabLanguagePolicy } from "./language-policy.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_ko TEXT NOT NULL DEFAULT '',
      name_ja TEXT NOT NULL DEFAULT '',
      name_zh TEXT NOT NULL DEFAULT ''
    );
  `);
  return db;
}

describe("language-policy detectTargetDepartments", () => {
  it("오피스팩 커스텀 부서명(로컬라이즈드 이름)으로 관련 부서를 감지한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('language', '\"ko\"')").run();
      db.prepare(
        "INSERT INTO departments (id, name, name_ko, name_ja, name_zh) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
      ).run(
        "planning",
        "Pre-production",
        "프리프로덕션팀",
        "プリプロ班",
        "前期策划组",
        "dev",
        "Scene Engine",
        "씬 엔진팀",
        "シーン設計",
        "场景引擎组",
      );

      const { detectTargetDepartments } = initializeCollabLanguagePolicy({ db });
      const found = detectTargetDepartments("프리프로덕션팀과 씬 엔진팀이 함께 콘티를 준비해줘");

      expect(found).toContain("planning");
      expect(found).toContain("dev");
    } finally {
      db.close();
    }
  });

  it("팀/부서 접미어 없이도 부서명을 감지한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO settings (key, value) VALUES ('language', '\"ko\"')").run();
      db.prepare("INSERT INTO departments (id, name, name_ko, name_ja, name_zh) VALUES (?, ?, ?, ?, ?)").run(
        "planning",
        "Pre-production",
        "프리프로덕션팀",
        "プリプロ班",
        "前期策划组",
      );

      const { detectTargetDepartments } = initializeCollabLanguagePolicy({ db });
      const found = detectTargetDepartments("프리프로덕션 이슈를 먼저 검토해줘");

      expect(found).toContain("planning");
    } finally {
      db.close();
    }
  });
});
