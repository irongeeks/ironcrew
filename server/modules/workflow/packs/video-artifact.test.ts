import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildVideoArtifactFileName,
  resolveVideoArtifactRelativeCandidates,
  resolveVideoArtifactSpecForTask,
} from "./video-artifact.ts";

describe("video artifact naming", () => {
  it("프로젝트명+부서명 기반 파일명을 생성한다", () => {
    expect(buildVideoArtifactFileName("VID", "기획팀")).toBe("VID_기획팀_final.mp4");
    expect(buildVideoArtifactFileName("  Demo Project  ", "Design Ops")).toBe("Demo_Project_Design_Ops_final.mp4");
  });

  it("task 메타에서 영상 산출물 경로 후보를 계산한다", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT, name_ko TEXT);
      `);
      db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run("proj-1", "VID");
      db.prepare("INSERT INTO departments (id, name, name_ko) VALUES (?, ?, ?)").run("planning", "Planning", "기획팀");

      const spec = resolveVideoArtifactSpecForTask(db as any, {
        project_id: "proj-1",
        department_id: "planning",
        project_path: "/tmp/vid-project",
      });

      expect(spec.relativePath).toBe("video_output/VID_기획팀_final.mp4");
      expect(resolveVideoArtifactRelativeCandidates(spec)).toEqual([
        "video_output/VID_기획팀_final.mp4",
        "video_output/final.mp4",
        "out/VID_기획팀_final.mp4",
        "out/final.mp4",
      ]);
    } finally {
      db.close();
    }
  });
});
