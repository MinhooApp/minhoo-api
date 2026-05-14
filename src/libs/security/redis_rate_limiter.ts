/**
 * Redis-backed distributed rate limiter
 *
 * Uses a fixed-window INCR+PEXPIRE approach (atomic via Lua).
 * Falls back transparently to an in-memory counter when Redis is unavailable.
 *
 * Designed to be a drop-in replacement for the in-memory limiter so that
 * blue/green processes (ports 3000 + 3001) share the same counters.
 */

import { NextFunction, Request, Response } from "express";
import { RequestRateLimitOptions } from "../middlewares/request_rate_limiter";

// ------------------------------------------------------------------
// Redis client (lazy, singleton, same pattern as find_session_store)
// ------------------------------------------------------------------

type MinimalRedis = {
  isReady?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  connect: () => Promise<void>;
  eval: (script: string, options: any) => Promise<any>;
};

let _redisPromise: Promise<MinimalRedis | null> | null = null;
let _redisDisabledUntil = 0;

const getRedis = async (): Promise<MinimalRedis | null> => {
  if (Date.now() < _redisDisabledUntil) return null;
  if (_redisPromise) return _redisPromise;

  _redisPromise = (async (): Promise<MinimalRedis | null> => {
    const url = String(process.env.REDIS_URL ?? "").trim();
    if (!url) return null;

    let redisModule: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      redisModule = require("redis");
    } catch {
      return null;
    }

    try {
      const client: MinimalRedis = redisModule.createClient({ url });
      client.on("error", () => {});
      await client.connect();
      return client;
    } catch (err) {
      _redisPromise = null;
      _redisDisabledUntil = Date.now() + 30_000;
      console.warn("[redis_rate_limiter] Redis unavailable, using memory fallback:", err);
      return null;
    }
  })();

  const client = await _redisPromise;
  if (!client) {
    _redisPromise = null;
  }
  return client;
};

// ------------------------------------------------------------------
// Lua script — atomic fixed-window INCR
// Returns [current_count, pttl_ms]
// ------------------------------------------------------------------
const LUA_INCR = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('PTTL', KEYS[1])}
`;

async function redisIncr(
  key: string,
  windowMs: number
): Promise<{ count: number; ttlMs: number } | null> {
  const client = await getRedis();
  if (!client) return null;

  try {
    const result: any = await client.eval(LUA_INCR, {
      keys: [key],
      arguments: [String(windowMs)],
    });
    return {
      count: Number(Array.isArray(result) ? result[0] : result),
      ttlMs: Number(Array.isArray(result) ? result[1] : windowMs),
    };
  } catch (err) {
    // Transient Redis error → fall back to memory for this request
    console.warn("[redis_rate_limiter] eval error, using memory fallback:", err);
    return null;
  }
}

// ------------------------------------------------------------------
// In-memory fallback (identical logic to request_rate_limiter)
// ------------------------------------------------------------------
type MemEntry = {
  windowStartedAtMs: number;
  hits: number;
  blockedUntilMs: number;
  lastSeenAtMs: number;
};

const toPositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  return rounded < min ? fallback : rounded;
};

const normalizeIp = (rawIp: any) => {
  const ip = String(rawIp ?? "").trim();
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
};

const defaultKeyGenerator = (req: Request) =>
  normalizeIp((req as any).ip ?? (req as any)?.socket?.remoteAddress) || "unknown";

const writeRateHeaders = (
  res: Response,
  opts: { limit: number; remaining: number; resetAtMs: number; retryAfterSeconds?: number }
) => {
  res.set("X-RateLimit-Limit", String(opts.limit));
  res.set("X-RateLimit-Remaining", String(Math.max(0, opts.remaining)));
  res.set("X-RateLimit-Reset", String(Math.ceil(opts.resetAtMs / 1000)));
  if (Number.isFinite(opts.retryAfterSeconds)) {
    res.set("Retry-After", String(Math.max(1, Math.trunc(opts.retryAfterSeconds as number))));
  }
};

// ------------------------------------------------------------------
// Main factory
// ------------------------------------------------------------------

/**
 * Distributed rate limiter.
 * Uses Redis when REDIS_URL is configured; falls back to in-memory.
 * API-compatible with createRequestRateLimiter.
 */
export const createDistributedRateLimiter = (options: RequestRateLimitOptions) => {
  const windowMs = toPositiveInt(options.windowMs, 60_000);
  const max = toPositiveInt(options.max, 20);
  const blockDurationMs = toPositiveInt(options.blockDurationMs ?? 0, 0, 0);
  const maxEntries = toPositiveInt(options.maxEntries ?? 20_000, 20_000, 500);
  const keyPrefix = String(options.keyPrefix ?? "drl").trim() || "drl";
  const message = String(options.message ?? "too many requests").trim();
  const statusCode = toPositiveInt(options.statusCode ?? 429, 429);
  const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;
  const maxResolver = options.maxResolver;
  const blockDurationResolver = options.blockDurationResolver;
  const onLimit = options.onLimit;

  // In-memory fallback store
  const memStore = new Map<string, MemEntry>();
  let lastPruneAtMs = 0;
  const pruneEveryMs = Math.max(windowMs, 60_000);
  const staleAfterMs = Math.max(windowMs, blockDurationMs || 0, 120_000);

  const pruneMemory = (nowMs: number) => {
    if (nowMs - lastPruneAtMs < pruneEveryMs && memStore.size <= maxEntries) return;
    lastPruneAtMs = nowMs;
    for (const [key, entry] of memStore.entries()) {
      if (nowMs - entry.lastSeenAtMs > staleAfterMs && entry.blockedUntilMs <= nowMs) {
        memStore.delete(key);
      }
    }
    if (memStore.size > maxEntries) {
      // evict oldest entry
      let oldest = "";
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [k, v] of memStore.entries()) {
        if (v.lastSeenAtMs < oldestTs) { oldestTs = v.lastSeenAtMs; oldest = k; }
      }
      if (oldest) memStore.delete(oldest);
    }
  };

  const memConsume = (
    key: string,
    nowMs: number,
    maxForReq: number,
    blockDurForReq: number
  ): { allowed: boolean; remaining: number; retryAfterMs: number; resetAtMs: number } => {
    pruneMemory(nowMs);
    const entry = memStore.get(key) ?? {
      windowStartedAtMs: nowMs,
      hits: 0,
      blockedUntilMs: 0,
      lastSeenAtMs: nowMs,
    };

    if (entry.blockedUntilMs > nowMs) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.blockedUntilMs - nowMs,
        resetAtMs: entry.blockedUntilMs,
      };
    }

    if (nowMs - entry.windowStartedAtMs >= windowMs) {
      entry.windowStartedAtMs = nowMs;
      entry.hits = 0;
      entry.blockedUntilMs = 0;
    }

    entry.hits += 1;
    entry.lastSeenAtMs = nowMs;
    const resetAtMs = entry.windowStartedAtMs + windowMs;

    if (entry.hits > maxForReq) {
      entry.blockedUntilMs = blockDurForReq > 0 ? nowMs + blockDurForReq : 0;
      memStore.set(key, entry);
      const retryAfterMs =
        entry.blockedUntilMs > nowMs
          ? entry.blockedUntilMs - nowMs
          : Math.max(1, resetAtMs - nowMs);
      return { allowed: false, remaining: 0, retryAfterMs, resetAtMs };
    }

    memStore.set(key, entry);
    return { allowed: true, remaining: Math.max(0, maxForReq - entry.hits), retryAfterMs: 0, resetAtMs };
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const nowMs = Date.now();
    const rawKey = keyGenerator(req);
    const maxForReq = toPositiveInt(maxResolver?.(req), max);
    const blockDurForReq = toPositiveInt(blockDurationResolver?.(req), blockDurationMs, 0);
    const fullKey = `${keyPrefix}:${String(rawKey ?? "unknown").trim() || "unknown"}`;

    // --- Try Redis ---
    const redisResult = await redisIncr(fullKey, windowMs);

    let allowed: boolean;
    let remaining: number;
    let retryAfterMs: number;
    let resetAtMs: number;

    if (redisResult) {
      const { count, ttlMs } = redisResult;
      resetAtMs = ttlMs > 0 ? nowMs + ttlMs : nowMs + windowMs;
      allowed = count <= maxForReq;
      remaining = Math.max(0, maxForReq - count);
      retryAfterMs = allowed ? 0 : Math.max(1, ttlMs > 0 ? ttlMs : windowMs);
    } else {
      // Fallback to in-memory
      const mem = memConsume(fullKey, nowMs, maxForReq, blockDurForReq);
      allowed = mem.allowed;
      remaining = mem.remaining;
      retryAfterMs = mem.retryAfterMs;
      resetAtMs = mem.resetAtMs;
    }

    const retryAfterSeconds = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : undefined;

    writeRateHeaders(res, { limit: maxForReq, remaining, resetAtMs, retryAfterSeconds });

    if (!allowed) {
      try {
        onLimit?.({
          req,
          key: fullKey,
          keyPrefix,
          hits: maxForReq + 1,
          limit: maxForReq,
          statusCode,
          retryAfterSeconds: retryAfterSeconds ?? 1,
          blockedUntilMs: resetAtMs,
          message,
        });
      } catch {
        // do not break request on audit callback error
      }
      res.status(statusCode).json({
        header: { success: false },
        body: { message, retry_after_seconds: retryAfterSeconds ?? 1 },
      });
      return;
    }

    next();
  };
};
