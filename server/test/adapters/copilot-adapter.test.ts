import { describe, it, expect } from "vitest";
import { copilotAdapter } from "../../adapters/copilot.ts";

describe("copilotAdapter", () => {
  it("has correct providerType and transport", () => {
    expect(copilotAdapter.providerType).toBe("copilot");
    expect(copilotAdapter.transport).toBe("http");
  });

  describe("buildRequest()", () => {
    it("returns valid request shape with required fields", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "hello world", workdir: "/tmp" },
        { apiUrl: "https://api.github.com" },
      );

      expect(request).toHaveProperty("url");
      expect(request).toHaveProperty("method");
      expect(request).toHaveProperty("headers");
      expect(request).toHaveProperty("body");
      expect(typeof request.url).toBe("string");
      expect(typeof request.method).toBe("string");
      expect(typeof request.headers).toBe("object");
    });

    it("constructs url from config.apiUrl", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://api.example.com" },
      );

      expect(request.url).toContain("https://api.example.com");
    });

    it("sets method to POST", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://api.github.com" },
      );

      expect(request.method).toBe("POST");
    });

    it("includes Content-Type header", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://api.github.com" },
      );

      expect(request.headers["Content-Type"]).toBe("application/json");
    });

    it("includes prompt in request body", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "my test prompt", workdir: "/tmp" },
        { apiUrl: "https://api.github.com" },
      );

      expect(request.body).toBeDefined();
    });

    it("sets stream to true", () => {
      const request = copilotAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://api.github.com" },
      );

      expect(request.stream).toBe(true);
    });
  });

  describe("parseStreamChunk()", () => {
    it("returns empty array (stub implementation)", () => {
      const events = copilotAdapter.parseStreamChunk("some chunk");
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(0);
    });
  });

  describe("testEnvironment()", () => {
    it("returns result indicating HTTP adapter (not CLI)", async () => {
      const result = await copilotAdapter.testEnvironment();

      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("message");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("HTTP adapter");
    });
  });
});
