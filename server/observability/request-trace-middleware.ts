import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response, NextFunction } from "express";
import { requestContext } from "./request-context.ts";
import { logger } from "./logger.ts";

const log = logger.child({ module: "http" });

interface MetricsSink {
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  incCounter(name: string, labels?: Record<string, string>): void;
}

export function createRequestTraceMiddleware(metrics: MetricsSink) {
  return function requestTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers["x-request-id"] as string) || randomUUID();
    (req as any).requestId = requestId;
    const start = performance.now();

    res.on("finish", () => {
      const duration = performance.now() - start;
      // IMPORTANT: Never use req.path as metric label — unbounded cardinality.
      // req.route?.path gives the template, not the instance.
      // Fallback is always "unmatched" — never the raw path.
      const route = (req as any).route?.path || "unmatched";
      const status = String(res.statusCode);

      log.info(
        { requestId, method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(duration) },
        "request completed",
      );

      metrics.recordHistogram("http.request.duration_ms", duration, { method: req.method, route, status });
      metrics.incCounter("http.request.count", { method: req.method, route, status });
    });

    requestContext.run({ requestId }, () => next());
  };
}
