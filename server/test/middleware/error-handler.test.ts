import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { globalErrorHandler } from "../../middleware/error-handler.ts";
import { AppError, NotFoundError, ValidationError } from "../../errors.ts";

// Mock the logger
vi.mock("../../observability/logger.ts", () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

function createMockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as Response;
  return res;
}

const mockReq = { method: "GET", originalUrl: "/api/test" } as Request;
const mockNext = vi.fn() as NextFunction;

describe("globalErrorHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles operational AppError with correct status and body", () => {
    const err = new NotFoundError("Agent not found", "agent_not_found");
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "agent_not_found",
      message: "Agent not found",
    });
  });

  it("handles ValidationError with 400", () => {
    const err = new ValidationError("name is required", "invalid_name");
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "invalid_name",
      message: "name is required",
    });
  });

  it("handles non-operational AppError as 500 without message leak", () => {
    const err = new AppError("db corrupted", "internal_error", 500, false);
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "internal_error",
    });
  });

  it("preserves status from express middleware errors (e.g. body-parser 400)", () => {
    const err = new SyntaxError("Unexpected token x in JSON at position 0");
    (err as any).status = 400;
    (err as any).type = "entity.parse.failed";
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "bad_request",
      message: "Unexpected token x in JSON at position 0",
    });
  });

  it("does not leak status from 5xx middleware errors", () => {
    const err = new Error("something broke");
    (err as any).status = 503;
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "internal_error",
    });
  });

  it("handles plain Error as 500 without message leak", () => {
    const err = new Error("unexpected failure");
    const res = createMockRes();

    globalErrorHandler(err, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "internal_error",
    });
  });

  it("handles non-Error throw as 500", () => {
    const err = "string error";
    const res = createMockRes();

    globalErrorHandler(err as unknown as Error, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: "internal_error",
    });
  });

  it("delegates to next() if headers already sent", () => {
    const err = new Error("too late");
    const res = createMockRes();
    (res as any).headersSent = true;
    const next = vi.fn();

    globalErrorHandler(err, mockReq, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
