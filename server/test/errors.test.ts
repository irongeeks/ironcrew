import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} from "../errors.ts";

describe("AppError", () => {
  it("has correct defaults", () => {
    const err = new AppError("something broke", "internal_error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("internal_error");
    expect(err.statusCode).toBe(500);
    expect(err.isOperational).toBe(true);
    expect(err.name).toBe("AppError");
  });

  it("accepts custom statusCode and isOperational", () => {
    const err = new AppError("bug", "bug", 503, false);
    expect(err.statusCode).toBe(503);
    expect(err.isOperational).toBe(false);
  });
});

describe("ValidationError", () => {
  it("has statusCode 400", () => {
    const err = new ValidationError("bad input");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("validation_failed");
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe("ValidationError");
  });

  it("accepts custom code", () => {
    const err = new ValidationError("bad field", "invalid_email");
    expect(err.code).toBe("invalid_email");
  });
});

describe("AuthenticationError", () => {
  it("has statusCode 401", () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("authentication_required");
    expect(err.message).toBe("Authentication required");
  });
});

describe("ForbiddenError", () => {
  it("has statusCode 403", () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("forbidden");
  });
});

describe("NotFoundError", () => {
  it("has statusCode 404", () => {
    const err = new NotFoundError("Agent not found", "agent_not_found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("agent_not_found");
    expect(err.message).toBe("Agent not found");
  });

  it("uses defaults", () => {
    const err = new NotFoundError();
    expect(err.message).toBe("Resource not found");
    expect(err.code).toBe("not_found");
  });
});

describe("ConflictError", () => {
  it("has statusCode 409", () => {
    const err = new ConflictError("Agent already exists", "already_exists");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("already_exists");
    expect(err.message).toBe("Agent already exists");
  });

  it("uses defaults", () => {
    const err = new ConflictError();
    expect(err.message).toBe("Resource conflict");
    expect(err.code).toBe("conflict");
  });
});
