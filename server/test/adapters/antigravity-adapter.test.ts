import { describe, it, expect } from "vitest";
import { antigravityAdapter } from "../../adapters/antigravity.ts";

describe("antigravityAdapter", () => {
  it("has correct providerType and transport", () => {
    expect(antigravityAdapter.providerType).toBe("antigravity");
    expect(antigravityAdapter.transport).toBe("http");
  });

  describe("buildRequest()", () => {
    it("returns valid request shape with required fields", () => {
      const request = antigravityAdapter.buildRequest(
        { prompt: "hello world", workdir: "/tmp" },
        { apiUrl: "https://antigravity.api" },
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
      const request = antigravityAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://api.example.com" },
      );

      expect(request.url).toContain("https://api.example.com");
    });

    it("sets method to POST", () => {
      const request = antigravityAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://antigravity.api" },
      );

      expect(request.method).toBe("POST");
    });

    it("includes Content-Type header", () => {
      const request = antigravityAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://antigravity.api" },
      );

      expect(request.headers["Content-Type"]).toBe("application/json");
    });

    it("includes prompt in request body", () => {
      const request = antigravityAdapter.buildRequest(
        { prompt: "my test prompt", workdir: "/tmp" },
        { apiUrl: "https://antigravity.api" },
      );

      expect(request.body).toBeDefined();
    });

    it("sets stream to true", () => {
      const request = antigravityAdapter.buildRequest(
        { prompt: "test", workdir: "/tmp" },
        { apiUrl: "https://antigravity.api" },
      );

      expect(request.stream).toBe(true);
    });
  });

  describe("parseStreamChunk()", () => {
    it("returns empty array (stub implementation)", () => {
      const events = antigravityAdapter.parseStreamChunk("some chunk");
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(0);
    });
  });

  describe("testEnvironment()", () => {
    it("returns result indicating HTTP adapter (not CLI)", async () => {
      const result = await antigravityAdapter.testEnvironment();

      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("message");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("HTTP adapter");
    });
  });
});
