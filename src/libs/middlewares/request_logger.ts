/**
 * HTTP request logger middleware.
 * Emits one structured JSON log line per request on response finish.
 *
 * Fields: ts, level, event, method, path, status, duration_ms,
 *         request_id, user_id, ip, user_agent
 */

import { Request, Response, NextFunction } from "express";
import logger from "../logger/logger";

const SKIP_PATHS = new Set(["/api/v1/ping", "/api/v1/live"]);

const normalizeIp = (req: Request): string => {
  const raw =
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    String(req.socket?.remoteAddress ?? req.ip ?? "");
  return raw || "unknown";
};

export const requestLoggerMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const startMs = Date.now();

  res.on("finish", () => {
    const path = String(req.path ?? req.url ?? "");
    if (SKIP_PATHS.has(path)) return;

    const duration = Date.now() - startMs;
    const status = res.statusCode ?? 0;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

    logger[level]({
      event: "http.request",
      method: req.method,
      path,
      status,
      duration_ms: duration,
      request_id: String((res.locals as any)?.requestId ?? req.headers["x-request-id"] ?? ""),
      user_id: Number((req as any)?.userId ?? 0) || undefined,
      ip: normalizeIp(req),
      user_agent: String(req.headers["user-agent"] ?? "").slice(0, 120) || undefined,
    });
  });

  next();
};
