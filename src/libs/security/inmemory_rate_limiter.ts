type RateLimiterOptions = {
  windowMs: number;
  max: number;
  blockDurationMs?: number;
  cleanupIntervalOps?: number;
};

type RateEntry = {
  count: number;
  windowEndsAtMs: number;
  blockedUntilMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAtMs: number;
};

const normalizePositiveInt = (value: any, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
};

export const createInMemoryRateLimiter = (options: RateLimiterOptions) => {
  const windowMs = normalizePositiveInt(options.windowMs, 10_000);
  const max = Math.max(0, normalizePositiveInt(options.max, 1));
  const blockDurationMs = Math.max(
    0,
    normalizePositiveInt(options.blockDurationMs ?? windowMs, windowMs)
  );
  const cleanupIntervalOps = Math.max(
    50,
    normalizePositiveInt(options.cleanupIntervalOps ?? 200, 200)
  );

  const entries = new Map<string, RateEntry>();
  let operations = 0;

  const cleanup = (nowMs: number) => {
    for (const [key, entry] of entries.entries()) {
      if (entry.windowEndsAtMs <= nowMs && entry.blockedUntilMs <= nowMs) {
        entries.delete(key);
      }
    }
  };

  const consume = (keyRaw: string, costRaw = 1): RateLimitResult => {
    if (max <= 0) {
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        retryAfterMs: 0,
        resetAtMs: Date.now() + windowMs,
      };
    }

    const key = String(keyRaw ?? "").trim();
    if (!key) {
      return {
        allowed: true,
        remaining: max,
        retryAfterMs: 0,
        resetAtMs: Date.now() + windowMs,
      };
    }

    const nowMs = Date.now();
    operations += 1;
    if (operations % cleanupIntervalOps === 0) {
      cleanup(nowMs);
    }

    const cost = Math.max(1, normalizePositiveInt(costRaw, 1));
    const current = entries.get(key);
    const hasActiveWindow = !!current && current.windowEndsAtMs > nowMs;
    const entry: RateEntry = hasActiveWindow
      ? current!
      : {
          count: 0,
          windowEndsAtMs: nowMs + windowMs,
          blockedUntilMs: 0,
        };

    if (entry.blockedUntilMs > nowMs) {
      const retryAfterMs = Math.max(1, entry.blockedUntilMs - nowMs);
      entries.set(key, entry);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        resetAtMs: entry.windowEndsAtMs,
      };
    }

    entry.count += cost;
    if (entry.count > max) {
      entry.blockedUntilMs = nowMs + blockDurationMs;
      entries.set(key, entry);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: blockDurationMs,
        resetAtMs: entry.windowEndsAtMs,
      };
    }

    entries.set(key, entry);
    return {
      allowed: true,
      remaining: Math.max(0, max - entry.count),
      retryAfterMs: 0,
      resetAtMs: entry.windowEndsAtMs,
    };
  };

  const reset = (keyRaw: string) => {
    const key = String(keyRaw ?? "").trim();
    if (!key) return;
    entries.delete(key);
  };

  return {
    consume,
    reset,
  };
};
