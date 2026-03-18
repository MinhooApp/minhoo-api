type FindScope = "orbit" | "post" | "worker";
type FindStoreBackend = "redis" | "memory";

type LoadFindSessionStateParams<T> = {
  scope: FindScope;
  sessionKey: string;
  ttlSeconds: number;
  initialState: T;
};

type SaveFindSessionStateParams<T> = {
  scope: FindScope;
  sessionKey: string;
  ttlSeconds: number;
  state: T;
};

type LoadFindSessionStateResult<T> = {
  backend: FindStoreBackend;
  state: T;
};

type MemoryEntry = {
  expiresAtMs: number;
  payload: string;
};

const memoryStore = new Map<string, MemoryEntry>();

const normalizeMode = () => {
  const mode = String(process.env.FIND_SESSION_STORE ?? "auto")
    .trim()
    .toLowerCase();
  if (mode === "memory" || mode === "redis" || mode === "auto") return mode;
  return "auto";
};

const shouldUseRedis = () => {
  const mode = normalizeMode();
  return mode === "redis" || mode === "auto";
};

const redisPrefix = String(process.env.FIND_SESSION_REDIS_PREFIX ?? "find:session")
  .trim()
  .replace(/:+$/, "");

const buildRedisKey = (scope: FindScope, sessionKey: string) =>
  `${redisPrefix}:${scope}:${sessionKey}`;

const cloneState = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value));
};

const nowMs = () => Date.now();

const cleanupMemoryStore = () => {
  const now = nowMs();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAtMs <= now) {
      memoryStore.delete(key);
    }
  }
};

const readMemory = <T>(key: string, initialState: T): T => {
  cleanupMemoryStore();
  const entry = memoryStore.get(key);
  if (!entry) return cloneState(initialState);
  if (entry.expiresAtMs <= nowMs()) {
    memoryStore.delete(key);
    return cloneState(initialState);
  }
  try {
    return JSON.parse(entry.payload) as T;
  } catch {
    return cloneState(initialState);
  }
};

const writeMemory = <T>(key: string, ttlSeconds: number, state: T) => {
  const ttlMs = Math.max(1, Math.floor(ttlSeconds * 1000));
  memoryStore.set(key, {
    expiresAtMs: nowMs() + ttlMs,
    payload: JSON.stringify(state),
  });
};

type RedisConfig = {
  host: string;
  port: number;
  password?: string;
  db?: number;
};

const resolveRedisConfig = (): { url?: string; socket?: RedisConfig } | null => {
  const url = String(process.env.FIND_REDIS_URL ?? process.env.REDIS_URL ?? "").trim();
  if (url) return { url };

  const host = String(process.env.FIND_REDIS_HOST ?? process.env.REDIS_HOST ?? "").trim();
  if (!host) return null;

  const portRaw = Number(process.env.FIND_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 6379;
  const password = String(
    process.env.FIND_REDIS_PASSWORD ?? process.env.REDIS_PASSWORD ?? ""
  ).trim();
  const dbRaw = Number(process.env.FIND_REDIS_DB ?? process.env.REDIS_DB ?? 0);
  const db = Number.isFinite(dbRaw) && dbRaw >= 0 ? Math.floor(dbRaw) : 0;

  return {
    socket: {
      host,
      port,
      ...(password ? { password } : {}),
      ...(Number.isFinite(db) ? { db } : {}),
    },
  };
};

type RedisClientLike = {
  isReady?: boolean;
  on: (event: string, handler: (...args: any[]) => void) => void;
  connect: () => Promise<void>;
  get: (key: string) => Promise<string | null>;
  setEx: (key: string, ttlSeconds: number, value: string) => Promise<any>;
  expire: (key: string, ttlSeconds: number) => Promise<any>;
};

let redisClientPromise: Promise<RedisClientLike | null> | null = null;
let redisDisabledUntilMs = 0;
let redisFailureLogged = false;

const getRedisClient = async (): Promise<RedisClientLike | null> => {
  if (!shouldUseRedis()) return null;
  if (nowMs() < redisDisabledUntilMs) return null;
  if (redisClientPromise) return redisClientPromise;

  redisClientPromise = (async () => {
    const config = resolveRedisConfig();
    if (!config) return null;

    let redisModule: any = null;
    try {
      // Optional dependency. If not installed, fallback to memory.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      redisModule = require("redis");
    } catch {
      return null;
    }

    try {
      const client: RedisClientLike = config.url
        ? redisModule.createClient({ url: config.url })
        : redisModule.createClient(config.socket);

      client.on("error", () => {});
      await client.connect();
      return client;
    } catch (error) {
      redisDisabledUntilMs = nowMs() + 60_000;
      if (!redisFailureLogged) {
        redisFailureLogged = true;
        console.warn("[find_session_store] redis unavailable, fallback memory", error);
      }
      return null;
    }
  })();

  const client = await redisClientPromise;
  if (!client) {
    redisClientPromise = null;
  }
  return client;
};

export const loadFindSessionState = async <T>(
  params: LoadFindSessionStateParams<T>
): Promise<LoadFindSessionStateResult<T>> => {
  const sessionKey = String(params.sessionKey ?? "").trim();
  if (!sessionKey) {
    return {
      backend: "memory",
      state: cloneState(params.initialState),
    };
  }

  const ttlSeconds = Math.max(60, Math.floor(Number(params.ttlSeconds) || 0));
  const key = buildRedisKey(params.scope, sessionKey);
  const memoryFallbackState = readMemory<T>(key, params.initialState);

  const client = await getRedisClient();
  if (!client) {
    writeMemory(key, ttlSeconds, memoryFallbackState);
    return {
      backend: "memory",
      state: memoryFallbackState,
    };
  }

  try {
    const payload = await client.get(key);
    if (!payload) {
      const initialState = cloneState(params.initialState);
      await client.setEx(key, ttlSeconds, JSON.stringify(initialState));
      writeMemory(key, ttlSeconds, initialState);
      return {
        backend: "redis",
        state: initialState,
      };
    }

    const parsed = JSON.parse(payload) as T;
    await client.expire(key, ttlSeconds);
    writeMemory(key, ttlSeconds, parsed);
    return {
      backend: "redis",
      state: parsed,
    };
  } catch {
    writeMemory(key, ttlSeconds, memoryFallbackState);
    return {
      backend: "memory",
      state: memoryFallbackState,
    };
  }
};

export const saveFindSessionState = async <T>(
  params: SaveFindSessionStateParams<T>
): Promise<FindStoreBackend> => {
  const sessionKey = String(params.sessionKey ?? "").trim();
  if (!sessionKey) return "memory";

  const ttlSeconds = Math.max(60, Math.floor(Number(params.ttlSeconds) || 0));
  const key = buildRedisKey(params.scope, sessionKey);
  const payload = JSON.stringify(params.state);

  const client = await getRedisClient();
  if (!client) {
    writeMemory(key, ttlSeconds, params.state);
    return "memory";
  }

  try {
    await client.setEx(key, ttlSeconds, payload);
    writeMemory(key, ttlSeconds, params.state);
    return "redis";
  } catch {
    writeMemory(key, ttlSeconds, params.state);
    return "memory";
  }
};

export const getFindSessionStoreInfo = () => {
  return {
    mode: normalizeMode(),
    redisConfigured: Boolean(resolveRedisConfig()),
    keyPrefix: redisPrefix,
    memoryEntries: memoryStore.size,
  };
};

export default {
  loadFindSessionState,
  saveFindSessionState,
  getFindSessionStoreInfo,
};
