import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectPackTerminalArtifacts } from "./pack-artifact-collector.ts";

describe("collectPackTerminalArtifacts", () => {
  it("returns empty array when packRegistry has no matching pack", () => {
    const mockRegistry = {
      get: vi.fn().mockImplementation(() => {
        throw new Error("not found");
      }),
    };
    const result = collectPackTerminalArtifacts(mockRegistry as any, "unknown_pack", "/tmp/project");
    expect(result).toEqual([]);
  });

  it("returns empty array when no terminal output files exist", () => {
    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        graph: {
          terminals: ["final_report"],
          phases: [{ id: "final_report", outputs: [{ name: "report", path: "research_output/final_report.md" }] }],
        },
      }),
    };
    const result = collectPackTerminalArtifacts(mockRegistry as any, "web_research_report", "/tmp/nonexistent");
    expect(result).toEqual([]);
  });

  it("reads existing artifact file and truncates content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-test-"));
    const outputDir = path.join(tmpDir, "research_output");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "final_report.md"), "# Report\nContent here");

    const mockRegistry = {
      get: vi.fn().mockReturnValue({
        graph: {
          terminals: ["final_report"],
          phases: [{ id: "final_report", outputs: [{ name: "report", path: "research_output/final_report.md" }] }],
        },
      }),
    };
    const result = collectPackTerminalArtifacts(mockRegistry as any, "web_research_report", tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report");
    expect(result[0].path).toBe("research_output/final_report.md");
    expect(result[0].content).toContain("# Report");
    expect(result[0].sizeBytes).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
