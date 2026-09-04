import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateRemotionOnlyGateFromLogFiles } from "./video-render-engine-gate.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});

function makeLogsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ironcrew-remotion-gate-"));
  tempDirs.push(dir);
  return dir;
}

describe("evaluateRemotionOnlyGateFromLogFiles", () => {
  it("passes when remotion evidence exists and forbidden engines are absent", () => {
    const logsDir = makeLogsDir();
    fs.writeFileSync(
      path.join(logsDir, "task-a.log"),
      "pnpm exec remotion browser ensure\npnpm exec remotion render src/index.tsx Intro video_output/final.mp4 --log=verbose\n",
      "utf8",
    );

    const result = evaluateRemotionOnlyGateFromLogFiles({ logsDir, taskIds: ["task-a"] });

    expect(result.passed).toBe(true);
    expect(result.remotionEvidenceTaskIds).toEqual(["task-a"]);
    expect(result.forbiddenEngineTaskIds).toEqual([]);
  });

  it("fails when python movie renderer signals are present", () => {
    const logsDir = makeLogsDir();
    fs.writeFileSync(
      path.join(logsDir, "task-b.log"),
      "Good, moviepy 2.1.2 is available. I'll create a high-quality motion graphics video using Python/moviepy with Pillow.\n",
      "utf8",
    );

    const result = evaluateRemotionOnlyGateFromLogFiles({ logsDir, taskIds: ["task-b"] });

    expect(result.passed).toBe(false);
    expect(result.remotionEvidenceTaskIds).toEqual([]);
    expect(result.forbiddenEngineTaskIds).toEqual(["task-b"]);
  });

  it("ignores negated mentions but still requires remotion evidence", () => {
    const logsDir = makeLogsDir();
    fs.writeFileSync(path.join(logsDir, "task-c.log"), "Do not use moviepy.\n", "utf8");

    const result = evaluateRemotionOnlyGateFromLogFiles({ logsDir, taskIds: ["task-c"] });

    expect(result.forbiddenEngineTaskIds).toEqual([]);
    expect(result.passed).toBe(false);
  });

  it("does not treat policy ban lines as forbidden-engine usage", () => {
    const logsDir = makeLogsDir();
    fs.writeFileSync(
      path.join(logsDir, "task-d.log"),
      [
        "최종 렌더링 엔진은 반드시 Remotion만 사용하세요. Python(moviepy/Pillow) 기반 렌더링은 금지됩니다.",
        "pnpm exec remotion render src/index.tsx Intro video_output/final.mp4 --log=verbose",
      ].join("\n"),
      "utf8",
    );

    const result = evaluateRemotionOnlyGateFromLogFiles({ logsDir, taskIds: ["task-d"] });

    expect(result.passed).toBe(true);
    expect(result.forbiddenEngineTaskIds).toEqual([]);
    expect(result.remotionEvidenceTaskIds).toEqual(["task-d"]);
  });

  it("ignores thinking-stream policy lines and passes when remotion render evidence exists", () => {
    const logsDir = makeLogsDir();
    fs.writeFileSync(
      path.join(logsDir, "task-e.log"),
      [
        '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Use Remotion only (no Python/moviepy/Pillow, no ffmpeg standalone)"}}}',
        "pnpm exec remotion render src/index.tsx Intro video_output/final.mp4 --log=verbose",
      ].join("\n"),
      "utf8",
    );

    const result = evaluateRemotionOnlyGateFromLogFiles({ logsDir, taskIds: ["task-e"] });

    expect(result.passed).toBe(true);
    expect(result.forbiddenEngineTaskIds).toEqual([]);
    expect(result.remotionEvidenceTaskIds).toEqual(["task-e"]);
  });
});
