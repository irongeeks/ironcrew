import type { Response } from "express";

/**
 * Standard OctoOffice API error response shape.
 *
 * - `error` is a stable, machine-readable snake_case code.
 * - `message` is optional human-readable text.
 * - `details` is optional structured context (e.g. Zod error tree).
 */
export type HttpErrorBody = {
  error: string;
  message?: string;
  details?: unknown;
};

/**
 * Emit a normalised JSON error response. Returns the Express `Response`
 * so handlers can keep their `return res.status(...).json(...)` idiom.
 *
 * @example
 *   return httpError(res, 404, "task_not_found");
 *   return httpError(res, 400, "invalid_pid", "PID must be a positive integer");
 */
export function httpError(res: Response, status: number, code: string, message?: string, details?: unknown): Response {
  const body: HttpErrorBody = { error: code };
  if (message) body.message = message;
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}
