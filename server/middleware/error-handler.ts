import type { Request, Response, NextFunction } from "express";
import { AppError } from "../errors.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child({ module: "error-handler" });

export function globalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    if (err.isOperational) {
      log.warn({ err, method: req.method, url: req.originalUrl }, err.message);
      res.status(err.statusCode).json({
        ok: false,
        error: err.code,
        message: err.message,
      });
    } else {
      log.error({ err, method: req.method, url: req.originalUrl }, "non-operational error");
      res.status(500).json({
        ok: false,
        error: "internal_error",
      });
    }
    return;
  }

  // Express middleware (body-parser, multer, etc.) attach a numeric `status` to errors.
  // Preserve 4xx so clients see the real problem instead of a misleading 500.
  if (
    err instanceof Error &&
    typeof (err as any).status === "number" &&
    (err as any).status >= 400 &&
    (err as any).status < 500
  ) {
    const status: number = (err as any).status;
    log.warn({ err, method: req.method, url: req.originalUrl }, err.message);
    res.status(status).json({
      ok: false,
      error: "bad_request",
      message: err.message,
    });
    return;
  }

  if (err instanceof Error) {
    log.error({ err, method: req.method, url: req.originalUrl }, "unhandled route error");
  } else {
    log.error({ err: String(err), method: req.method, url: req.originalUrl }, "unhandled non-error throw");
  }

  res.status(500).json({
    ok: false,
    error: "internal_error",
  });
}
