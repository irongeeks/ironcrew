import { describe, expect, it, vi } from "vitest";
import { createRequestTraceMiddleware } from "../request-trace-middleware.ts";
import { requestContext } from "../request-context.ts";

describe("request-trace-middleware", () => {
  it("sets requestId on req and propagates via AsyncLocalStorage", () => {
    const middleware = createRequestTraceMiddleware({
      recordHistogram: vi.fn(),
      incCounter: vi.fn(),
    });

    let capturedRequestId: string | undefined;
    const req = { headers: {}, method: "GET", path: "/api/test" } as any;
    const res = {
      statusCode: 200,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") cb();
      }),
    } as any;

    middleware(req, res, () => {
      capturedRequestId = requestContext.getStore()?.requestId;
    });

    expect(req.requestId).toBeDefined();
    expect(typeof req.requestId).toBe("string");
    expect(capturedRequestId).toBe(req.requestId);
  });

  it("uses x-request-id header when provided", () => {
    const middleware = createRequestTraceMiddleware({
      recordHistogram: vi.fn(),
      incCounter: vi.fn(),
    });

    const req = { headers: { "x-request-id": "custom-id-123" }, method: "GET", path: "/test" } as any;
    const res = {
      statusCode: 200,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") cb();
      }),
    } as any;

    middleware(req, res, () => {});
    expect(req.requestId).toBe("custom-id-123");
  });

  it("records http.request.duration_ms with route template", () => {
    const recordHistogram = vi.fn();
    const middleware = createRequestTraceMiddleware({ recordHistogram, incCounter: vi.fn() });

    const req = {
      headers: {},
      method: "POST",
      path: "/api/core/tasks/abc123",
      route: { path: "/api/core/tasks/:taskId" },
    } as any;
    const res = {
      statusCode: 201,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") cb();
      }),
    } as any;

    middleware(req, res, () => {});

    expect(recordHistogram).toHaveBeenCalledWith("http.request.duration_ms", expect.any(Number), {
      method: "POST",
      route: "/api/core/tasks/:taskId",
      status: "201",
    });
  });

  it("uses 'unmatched' when no route template exists", () => {
    const recordHistogram = vi.fn();
    const middleware = createRequestTraceMiddleware({ recordHistogram, incCounter: vi.fn() });

    const req = { headers: {}, method: "GET", path: "/unknown/path/123" } as any;
    const res = {
      statusCode: 404,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") cb();
      }),
    } as any;

    middleware(req, res, () => {});

    expect(recordHistogram).toHaveBeenCalledWith(
      "http.request.duration_ms",
      expect.any(Number),
      expect.objectContaining({ route: "unmatched" }),
    );
  });

  it("records http.request.count counter", () => {
    const incCounter = vi.fn();
    const middleware = createRequestTraceMiddleware({ recordHistogram: vi.fn(), incCounter });

    const req = { headers: {}, method: "GET", path: "/api/test", route: { path: "/api/test" } } as any;
    const res = {
      statusCode: 200,
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "finish") cb();
      }),
    } as any;

    middleware(req, res, () => {});

    expect(incCounter).toHaveBeenCalledWith(
      "http.request.count",
      expect.objectContaining({ method: "GET", route: "/api/test", status: "200" }),
    );
  });
});
