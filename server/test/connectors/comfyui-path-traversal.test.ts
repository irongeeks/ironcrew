import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { downloadOutput } from "../../connectors/built-in/comfyui/http.ts";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockSuccessResponse() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
}

describe("comfyui downloadOutput path traversal protection", () => {
  const outputDir = "/tmp/comfyui-test-output";

  beforeEach(() => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows a normal filename", async () => {
    mockSuccessResponse();
    const result = await downloadOutput("http://localhost:8188", {}, "image.png", "", outputDir);
    expect(result).toBe(path.join(outputDir, "image.png"));
  });

  it("strips ../../etc/passwd to just 'passwd' via basename", async () => {
    mockSuccessResponse();
    const result = await downloadOutput("http://localhost:8188", {}, "../../etc/passwd", "", outputDir);
    // path.basename strips directory traversal, resulting in safe "passwd" in outputDir
    expect(result).toBe(path.join(outputDir, "passwd"));
  });

  it("strips ../secret.txt to just 'secret.txt' via basename", async () => {
    mockSuccessResponse();
    const result = await downloadOutput("http://localhost:8188", {}, "../secret.txt", "", outputDir);
    expect(result).toBe(path.join(outputDir, "secret.txt"));
  });

  it("strips subfolder from subfolder/image.png via basename", async () => {
    mockSuccessResponse();
    const result = await downloadOutput("http://localhost:8188", {}, "subfolder/image.png", "", outputDir);
    // path.basename("subfolder/image.png") => "image.png"
    expect(result).toBe(path.join(outputDir, "image.png"));
  });

  it("throws on empty filename", async () => {
    mockSuccessResponse();
    await expect(downloadOutput("http://localhost:8188", {}, "", "", outputDir)).rejects.toThrow(/Invalid filename/);
  });

  it("throws on '.' filename", async () => {
    mockSuccessResponse();
    await expect(downloadOutput("http://localhost:8188", {}, ".", "", outputDir)).rejects.toThrow(
      /Invalid filename|Path traversal/,
    );
  });

  it("throws on '..' filename", async () => {
    mockSuccessResponse();
    await expect(downloadOutput("http://localhost:8188", {}, "..", "", outputDir)).rejects.toThrow(
      /Invalid filename|Path traversal/,
    );
  });
});
