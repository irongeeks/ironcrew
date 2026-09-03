import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  resolveProjectDefaultPackKey,
  resolveTaskPackKeyById,
  resolveWorkflowPackKeyForTask,
} from "./task-pack-resolver.ts";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      default_pack_key TEXT NOT NULL DEFAULT 'development'
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workflow_pack_key TEXT NOT NULL DEFAULT 'development'
    );
  `);
  return db;
}

describe("task-pack-resolver", () => {
  it("explicit pack key가 있으면 최우선으로 사용한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");
      const resolved = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "video_preprod",
        sourceTaskId: "task-1",
        projectId: "project-1",
      });
      expect(resolved).toBe("video_preprod");
    } finally {
      db.close();
    }
  });

  it("source task pack -> project default 순으로 폴백한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");

      const fromTask = resolveWorkflowPackKeyForTask({
        db,
        sourceTaskId: "task-1",
        projectId: "project-1",
      });
      const fromProject = resolveWorkflowPackKeyForTask({
        db,
        sourceTaskId: "missing-task",
        projectId: "project-1",
      });

      expect(fromTask).toBe("report");
      expect(fromProject).toBe("novel");
    } finally {
      db.close();
    }
  });

  it("유효한 값이 없으면 fallback/default를 사용한다", () => {
    const db = setupDb();
    try {
      const withFallback = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "INVALID-PACK!",
        fallbackPackKey: "report",
      });
      const withDefault = resolveWorkflowPackKeyForTask({
        db,
        explicitPackKey: "INVALID-PACK!",
      });
      expect(withFallback).toBe("report");
      expect(withDefault).toBe("development");
    } finally {
      db.close();
    }
  });

  it("project/task 단건 조회 헬퍼가 유효한 pack만 반환한다", () => {
    const db = setupDb();
    try {
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-1", "novel");
      db.prepare("INSERT INTO tasks (id, workflow_pack_key) VALUES (?, ?)").run("task-1", "report");
      db.prepare("INSERT INTO projects (id, default_pack_key) VALUES (?, ?)").run("project-2", "INVALID-PACK!");

      expect(resolveProjectDefaultPackKey(db, "project-1")).toBe("novel");
      expect(resolveProjectDefaultPackKey(db, "project-2")).toBeNull();
      expect(resolveTaskPackKeyById(db, "task-1")).toBe("report");
      expect(resolveTaskPackKeyById(db, "missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});
