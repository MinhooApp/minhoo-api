import { NextFunction, Request, RequestHandler, Response } from "express";

type RateLimitEntry = {
  windowStartedAtMs: number;
  hits: number;
  blockedUntilMs: number;
  lastSeenAtMs: number;
};

type RateLimitKeyFn = (req: Request) => string;

export interface RequestRateLimitOptions {
  windowMs: number;
  max: number;
  blockDurationMs?: number;
  maxEntries?: number;
  keyPrefix?: string;
  message?: string;
  statusCode?: number;
  keyGenerator?: RateLimitKeyFn;
}

const normalizeIp = (rawIp: any) => {
  const ip = String(rawIp ?? "").trim();
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
};

const toPositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const oldestKeyByLastSeen = (store: Map<string, RateLimitEntry>) => {
  let oldestKey = "";
  let oldestSeenAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of store.entries()) {
    if (entry.lastSeenAtMs < oldestSeenAt) {
      oldestSeenAt = entry.lastSeenAtMs;
      oldestKey = key;
    }
  }
  return oldestKey;
};

const defaultKeyGenerator: RateLimitKeyFn = (req: Request) => {
  const ip = normalizeIp((req as any).ip ?? (req as any)?.socket?.remoteAddress);
  return ip || "unknown";
};

const writeRateHeaders = (
  res: Response,
  {
    limit,
    remaining,
    resetAtMs,
    retryAfterSeconds,
  }: {
    limit: number;
    remaining: number;
    resetAtMs: number;
    retryAfterSeconds?: number;
  }
) => {
  res.set("X-RateLimit-Limit", String(limit));
  res.set("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.set("X-RateLimit-Reset", String(Math.ceil(resetAtMs / 1000)));
  if (Number.isFinite(retryAfterSeconds)) {
    res.set("Retry-After", String(Math.max(1, Math.trunc(retryAfterSeconds as number))));
  }
};

export const createRequestRateLimiter = (
  options: RequestRateLimitOptions
): RequestHandler => {
  const windowMs = toPositiveInt(options.windowMs, 60_000);
  const max = toPositiveInt(options.max, 20);
  const blockDurationMs = toPositiveInt(options.blockDurationMs, 0, 0);
  const maxEntries = toPositiveInt(options.maxEntries, 20_000, 500);
  const keyPrefix = String(options.keyPrefix ?? "rl").trim() || "rl";
  const message = String(options.message ?? "too many requests").trim() || "too many requests";
  const statusCode = toPositiveInt(options.statusCode, 429);
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

  const store = new Map<string, RateLimitEntry>();
  let lastPruneAtMs = 0;
  const pruneEveryMs = Math.max(windowMs, 60_000);
  const staleAfterMs = Math.max(windowMs, blockDurationMs || 0, 120_000);

  return (req: Request, res: Response, next: NextFunction) => {
    const nowMs = Date.now();

    if (nowMs - lastPruneAtMs >= pruneEveryMs || store.size > maxEntries) {
      lastPruneAtMs = nowMs;

      for (const [key, entry] of store.entries()) {
        const inactiveTooLong = nowMs - entry.lastSeenAtMs > staleAfterMs;
        const blockExpired = entry.blockedUntilMs <= nowMs;
        if (inactiveTooLong && blockExpired) {
          store.delete(key);
        }
      }

      while (store.size > maxEntries) {
        const keyToDelete = oldestKeyByLastSeen(store);
        if (!keyToDelete) break;
        store.delete(keyToDelete);
      }
    }

    const keyRaw = keyGenerator(req);
    const key = `${keyPrefix}:${String(keyRaw ?? "unknown").trim() || "unknown"}`;
    const entry = store.get(key) ?? {
      windowStartedAtMs: nowMs,
      hits: 0,
      blockedUntilMs: 0,
      lastSeenAtMs: nowMs,
    };

    if (entry.blockedUntilMs > nowMs) {
      const retryAfterSeconds = Math.ceil((entry.blockedUntilMs - nowMs) / 1000);
      writeRateHeaders(res, {
        limit: max,
        remaining: 0,
        resetAtMs: entry.blockedUntilMs,
        retryAfterSeconds,
      });
      return res.status(statusCode).json({
        header: { success: false },
        body: {
          message,
          retry_after_seconds: retryAfterSeconds,
        },
      });
    }

    if (nowMs - entry.windowStartedAtMs >= windowMs) {
      entry.windowStartedAtMs = nowMs;
      entry.hits = 0;
      entry.blockedUntilMs = 0;
    }

    entry.hits += 1;
    entry.lastSeenAtMs = nowMs;
    const remaining = Math.max(0, max - entry.hits);
    const resetAtMs = entry.windowStartedAtMs + windowMs;

    if (entry.hits > max) {
      if (blockDurationMs > 0) {
        entry.blockedUntilMs = nowMs + blockDurationMs;
      }
      store.set(key, entry);
      const retryAfterSeconds =
        entry.blockedUntilMs > nowMs
          ? Math.ceil((entry.blockedUntilMs - nowMs) / 1000)
          : Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      writeRateHeaders(res, {
        limit: max,
        remaining: 0,
        resetAtMs: entry.blockedUntilMs > nowMs ? entry.blockedUntilMs : resetAtMs,
        retryAfterSeconds,
      });
      return res.status(statusCode).json({
        header: { success: false },
        body: {
          message,
          retry_after_seconds: retryAfterSeconds,
        },
      });
    }

    store.set(key, entry);
    writeRateHeaders(res, {
      limit: max,
      remaining,
      resetAtMs,
    });
    return next();
  };
};

export default createRequestRateLimiter;
