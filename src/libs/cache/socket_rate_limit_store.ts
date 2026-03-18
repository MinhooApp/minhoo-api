type RateLimitStoreMode = "auto" | "memory" | "redis";

type RedisClientConfig = {
  url?: string;
  socket?: {
    host: string;
    port: number;
  };
  password?: string;
  database?: number;
};

type RedisClientLike = {
  isReady?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  connect: () => Promise<void>;
  pTTL: (key: string) => Promise<number>;
  incr: (key: string) => Promise<number>;
  pExpire: (key: string, ttlMs: number) => Promise<number>;
  set: (key: string, value: string, options?: any) => Promise<any>;
};

export type DistributedIdentityRateLimitParams = {
  event: string;
  identity: string;
  maxPerWindow: number;
  windowMs: number;
  identityThreshold: number;
  blockMs: number;
};

export type DistributedIdentityRateLimitResult = {
  backend: "redis";
  limited: boolean;
  blocked: boolean;
  count: number;
  retryAfterMs: number;
};

const normalizeMode = (): RateLimitStoreMode => {
  const raw = String(process.env.SOCKET_RATE_LIMIT_STORE ?? "auto")
    .trim()
    .toLowerCase();
  if (raw === "memory" || raw === "redis" || raw === "auto") return raw;
  return "auto";
};

const shouldUseRedis = () => {
  const mode = normalizeMode();
  return mode === "redis" || mode === "auto";
};

const redisPrefix = String(process.env.SOCKET_RATE_LIMIT_REDIS_PREFIX ?? "socket:rl")
  .trim()
  .replace(/:+$/, "");

const nowMs = () => Date.now();

const resolveRedisConfig = (): RedisClientConfig | null => {
  const url = String(
    process.env.SOCKET_RATE_LIMIT_REDIS_URL ??
      process.env.SOCKET_REDIS_URL ??
      process.env.REDIS_URL ??
      ""
  ).trim();
  if (url) return { url };

  const host = String(
    process.env.SOCKET_RATE_LIMIT_REDIS_HOST ??
      process.env.SOCKET_REDIS_HOST ??
      process.env.REDIS_HOST ??
      ""
  ).trim();
  if (!host) return null;

  const portRaw = Number(
    process.env.SOCKET_RATE_LIMIT_REDIS_PORT ??
      process.env.SOCKET_REDIS_PORT ??
      process.env.REDIS_PORT ??
      6379
  );
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 6379;

  const password = String(
    process.env.SOCKET_RATE_LIMIT_REDIS_PASSWORD ??
      process.env.SOCKET_REDIS_PASSWORD ??
      process.env.REDIS_PASSWORD ??
      ""
  ).trim();
  const dbRaw = Number(
    process.env.SOCKET_RATE_LIMIT_REDIS_DB ??
      process.env.SOCKET_REDIS_DB ??
      process.env.REDIS_DB ??
      0
  );
  const database = Number.isFinite(dbRaw) && dbRaw >= 0 ? Math.floor(dbRaw) : 0;

  return {
    socket: { host, port },
    ...(password ? { password } : {}),
    ...(Number.isFinite(database) ? { database } : {}),
  };
};

let redisClientPromise: Promise<RedisClientLike | null> | null = null;
let redisDisabledUntilMs = 0;
let redisFailureLogged = false;

const markRedisTemporarilyUnavailable = (error: unknown) => {
  redisDisabledUntilMs = nowMs() + 60_000;
  redisClientPromise = null;
  if (!redisFailureLogged) {
    redisFailureLogged = true;
    console.warn("[socket_rate_limit_store] redis unavailable, fallback local", error);
  }
};

const getRedisClient = async (): Promise<RedisClientLike | null> => {
  if (!shouldUseRedis()) return null;
  if (nowMs() < redisDisabledUntilMs) return null;
  if (redisClientPromise) return redisClientPromise;

  redisClientPromise = (async () => {
    const config = resolveRedisConfig();
    if (!config) return null;

    let redisModule: any = null;
    try {
      // Optional dependency. If not installed, fallback local.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      redisModule = require("redis");
    } catch {
      if (normalizeMode() === "redis" && !redisFailureLogged) {
        redisFailureLogged = true;
        console.warn(
          "[socket_rate_limit_store] SOCKET_RATE_LIMIT_STORE=redis but redis package is missing"
        );
      }
      return null;
    }

    const createClient =
      typeof redisModule?.createClient === "function" ? redisModule.createClient : null;
    if (!createClient) {
      if (!redisFailureLogged) {
        redisFailureLogged = true;
        console.warn("[socket_rate_limit_store] redis.createClient is unavailable");
      }
      return null;
    }

    try {
      const client: RedisClientLike = createClient(config);
      client.on("error", () => {});
      if (!client.isReady) {
        await client.connect();
      }
      redisFailureLogged = false;
      return client;
    } catch (error) {
      markRedisTemporarilyUnavailable(error);
      return null;
    }
  })();

  const client = await redisClientPromise;
  if (!client) {
    redisClientPromise = null;
  }
  return client;
};

const normalizePositiveNumber = (value: number, fallback: number, min: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.max(min, fallback);
  return Math.max(min, Math.floor(parsed));
};

const encodeKeyPart = (value: string) => encodeURIComponent(String(value ?? "").trim());

const buildCounterKey = (event: string, identity: string) =>
  `${redisPrefix}:counter:${encodeKeyPart(event)}:${encodeKeyPart(identity)}`;

const buildBlockKey = (event: string, identity: string) =>
  `${redisPrefix}:block:${encodeKeyPart(event)}:${encodeKeyPart(identity)}`;

export const checkDistributedIdentityRateLimit = async (
  params: DistributedIdentityRateLimitParams
): Promise<DistributedIdentityRateLimitResult | null> => {
  const event = String(params.event ?? "").trim();
  const identity = String(params.identity ?? "").trim();
  if (!event || !identity) return null;

  const maxPerWindow = normalizePositiveNumber(params.maxPerWindow, 1, 1);
  const windowMs = normalizePositiveNumber(params.windowMs, 250, 250);
  const identityThreshold = normalizePositiveNumber(
    params.identityThreshold,
    maxPerWindow + 1,
    maxPerWindow + 1
  );
  const blockMs = normalizePositiveNumber(params.blockMs, 1000, 250);

  const client = await getRedisClient();
  if (!client) return null;

  const counterKey = buildCounterKey(event, identity);
  const blockKey = buildBlockKey(event, identity);

  try {
    const blockedTtlMs = Number(await client.pTTL(blockKey));
    if (blockedTtlMs > 0) {
      return {
        backend: "redis",
        limited: true,
        blocked: true,
        count: 0,
        retryAfterMs: blockedTtlMs,
      };
    }

    const incrementedCount = Number(await client.incr(counterKey));
    if (incrementedCount <= 1) {
      await client.pExpire(counterKey, windowMs);
    } else {
      const ttlMs = Number(await client.pTTL(counterKey));
      if (ttlMs <= 0) {
        await client.pExpire(counterKey, windowMs);
      }
    }

    if (incrementedCount >= identityThreshold) {
      await client.set(blockKey, "1", { PX: blockMs });
      return {
        backend: "redis",
        limited: true,
        blocked: true,
        count: incrementedCount,
        retryAfterMs: blockMs,
      };
    }

    if (incrementedCount > maxPerWindow) {
      const ttlMs = Number(await client.pTTL(counterKey));
      return {
        backend: "redis",
        limited: true,
        blocked: false,
        count: incrementedCount,
        retryAfterMs: ttlMs > 0 ? ttlMs : windowMs,
      };
    }

    return {
      backend: "redis",
      limited: false,
      blocked: false,
      count: incrementedCount,
      retryAfterMs: 0,
    };
  } catch (error) {
    markRedisTemporarilyUnavailable(error);
    return null;
  }
};

export const getSocketRateLimitStoreInfo = () => {
  return {
    mode: normalizeMode(),
    redisConfigured: Boolean(resolveRedisConfig()),
    redisPrefix,
  };
};

export default {
  checkDistributedIdentityRateLimit,
  getSocketRateLimitStoreInfo,
};
