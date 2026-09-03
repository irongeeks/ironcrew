export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, code: string, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = "validation_failed") {
    super(message, code, 400);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required", code = "authentication_required") {
    super(message, code, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "forbidden") {
    super(message, code, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code = "not_found") {
    super(message, code, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", code = "conflict") {
    super(message, code, 409);
  }
}
