import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectorExecuteResult } from "../../connectors/connector-interface.ts";

// Mock the comfyui HTTP helpers before importing the connector. The canonical
// location is now server/connectors/built-in/comfyui/http.ts (the connector
// imports directly from there). The legacy modules/workflow/comfyui/ path is
// kept as a deprecated re-export only.
vi.mock("../../connectors/built-in/comfyui/http.ts", () => ({
  submitWorkflow: vi.fn().mockResolvedValue({ promptId: "test-prompt-id" }),
  pollJobCompletion: vi.fn().mockResolvedValue({
    status: "success",
    outputs: [{ filename: "image.png", subfolder: "", type: "output" }],
    executionTimeMs: 1200,
  }),
  downloadOutput: vi.fn().mockResolvedValue("/tmp/output/image.png"),
  injectParameters: vi.fn((workflow) => workflow),
}));

// Mock fetch for testConnection
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { comfyuiConnector } from "../../connectors/built-in/comfyui/connector.ts";
import { submitWorkflow, pollJobCompletion, downloadOutput } from "../../connectors/built-in/comfyui/http.ts";

describe("comfyuiConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default resolved values after clearAllMocks wipes them
    vi.mocked(submitWorkflow).mockResolvedValue({ promptId: "test-prompt-id" });
    vi.mocked(pollJobCompletion).mockResolvedValue({
      status: "success",
      outputs: [{ filename: "image.png", subfolder: "", type: "output" }],
      executionTimeMs: 1200,
    });
    vi.mocked(downloadOutput).mockResolvedValue("/tmp/output/image.png");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("exposes text2img capability", () => {
      const cap = comfyuiConnector.capabilities.find((c) => c.name === "text2img");
      expect(cap).toBeDefined();
      expect(cap?.description).toBeTruthy();
    });

    it("exposes img2video capability", () => {
      const cap = comfyuiConnector.capabilities.find((c) => c.name === "img2video");
      expect(cap).toBeDefined();
      expect(cap?.description).toBeTruthy();
    });

    it("has exactly 3 capabilities", () => {
      expect(comfyuiConnector.capabilities).toHaveLength(3);
    });
  });

  describe("getAgentGuidance", () => {
    it("returns a non-empty string for text2img", () => {
      const guidance = comfyuiConnector.getAgentGuidance!("text2img", { serverUrl: "http://localhost:8188" }, "en");
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(0);
    });

    it("returns a non-empty string for img2video", () => {
      const guidance = comfyuiConnector.getAgentGuidance!("img2video", { serverUrl: "http://localhost:8188" }, "en");
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(0);
    });

    it("includes the server URL in the guidance when provided", () => {
      const serverUrl = "http://localhost:8188";
      const guidance = comfyuiConnector.getAgentGuidance!("text2img", { serverUrl }, "en");
      expect(guidance).toContain(serverUrl);
    });

    it("returns guidance even without server URL config", () => {
      const guidance = comfyuiConnector.getAgentGuidance!("text2img", {}, "en");
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(0);
    });
  });

  describe("testConnection", () => {
    it("calls /system_stats on the configured server URL and returns ok:true on success", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ system: {} }) });

      const result = await comfyuiConnector.testConnection({ serverUrl: "http://localhost:8188" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8188/system_stats",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.ok).toBe(true);
      expect(result.message).toBeTruthy();
    });

    it("returns ok:false when fetch fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await comfyuiConnector.testConnection({ serverUrl: "http://localhost:8188" });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Connection refused");
    });

    it("returns ok:false when server responds with non-ok status", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });

      const result = await comfyuiConnector.testConnection({ serverUrl: "http://localhost:8188" });

      expect(result.ok).toBe(false);
      expect(result.message).toBeTruthy();
    });

    it("returns ok:false for cloud metadata endpoint (SSRF protection)", async () => {
      const result = await comfyuiConnector.testConnection({ serverUrl: "http://169.254.169.254/latest" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("blocked address range");
    });

    it("returns ok:false when no serverUrl is provided", async () => {
      const result = await comfyuiConnector.testConnection({});
      expect(result.ok).toBe(false);
    });
  });

  describe("execute", () => {
    const baseConfig = {
      serverUrl: "http://localhost:8188",
      authHeaders: {},
      workflowJson: { "1": { inputs: { text: "" }, class_type: "CLIPTextEncode" } },
      outputDir: "/tmp/output",
    };

    it("delegates to submitWorkflow → pollJobCompletion → downloadOutput for text2img", async () => {
      const result = await comfyuiConnector.execute("text2img", { prompt: "a sunset over mountains" }, baseConfig);

      // No parameterMappings in baseConfig → overrides are undefined (workflow runs as-is)
      expect(submitWorkflow).toHaveBeenCalledWith(
        baseConfig.serverUrl,
        baseConfig.authHeaders,
        baseConfig.workflowJson,
        undefined,
      );
      expect(pollJobCompletion).toHaveBeenCalledWith(
        baseConfig.serverUrl,
        baseConfig.authHeaders,
        "test-prompt-id",
        expect.any(Number),
        expect.any(Number),
      );
      expect(downloadOutput).toHaveBeenCalled();
      expect(result.status).toBe("success");
    });

    it("returns artifacts with local paths on success", async () => {
      const result = await comfyuiConnector.execute("text2img", { prompt: "test" }, baseConfig);

      expect(result.status).toBe("success");
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].path).toBe("/tmp/output/image.png");
      expect(result.artifacts[0].type).toBe("image");
    });

    it("delegates to submitWorkflow → pollJobCompletion → downloadOutput for img2video", async () => {
      const result = await comfyuiConnector.execute(
        "img2video",
        { prompt: "animate this", input_image: "/tmp/frame.png" },
        baseConfig,
      );

      expect(submitWorkflow).toHaveBeenCalled();
      expect(pollJobCompletion).toHaveBeenCalled();
      expect(result.status).toBe("success");
    });

    it("returns error status when pollJobCompletion reports error", async () => {
      vi.mocked(pollJobCompletion).mockResolvedValueOnce({
        status: "error",
        outputs: [],
        executionTimeMs: 500,
        error: "ComfyUI node failed",
      });

      const result = await comfyuiConnector.execute("text2img", { prompt: "test" }, baseConfig);

      expect(result.status).toBe("error");
      expect(result.error).toBeTruthy();
    });

    it("returns timeout status when pollJobCompletion times out", async () => {
      vi.mocked(pollJobCompletion).mockResolvedValueOnce({
        status: "timeout",
        outputs: [],
        executionTimeMs: 300_000,
        error: "timed out",
      });

      const result = await comfyuiConnector.execute("text2img", { prompt: "test" }, baseConfig);

      expect(result.status).toBe("timeout");
    });

    it("throws when an unsupported capability is requested", async () => {
      await expect(comfyuiConnector.execute("tts", { text: "hello" }, baseConfig)).rejects.toThrow(
        /unsupported capability/i,
      );
    });

    it("includes costInfo with durationMs", async () => {
      const result = await comfyuiConnector.execute("text2img", { prompt: "test" }, baseConfig);

      expect(result.costInfo).toBeDefined();
      expect(typeof result.costInfo?.durationMs).toBe("number");
    });

    it("returns error status and does not throw when submitWorkflow fails", async () => {
      vi.mocked(submitWorkflow).mockRejectedValueOnce(new Error("ComfyUI /prompt failed (500)"));

      const result: ConnectorExecuteResult = await comfyuiConnector.execute("text2img", { prompt: "test" }, baseConfig);

      expect(result.status).toBe("error");
      expect(result.error).toContain("ComfyUI /prompt failed");
    });
  });
});
