import { loadFindSessionState, saveFindSessionState } from "./find_session_store";

type VersionState = {
  version: number;
  updatedAtMs: number;
};

type LocalVersionEntry = {
  version: number;
  expiresAtMs: number;
};

const versionStoreTtlSeconds = Math.max(
  60,
  Number(process.env.HOME_CACHE_VERSION_STORE_TTL_SECONDS ?? 30 * 24 * 60 * 60) ||
    30 * 24 * 60 * 60
);
const localVersionReadTtlMs = Math.max(
  250,
  Number(process.env.HOME_CACHE_VERSION_LOCAL_TTL_MS ?? 1500) || 1500
);

const localVersionCache = new Map<string, LocalVersionEntry>();

const CONTENT_VERSION_KEY = "__version:bootstrap:home:content";
const toNotificationsVersionKey = (userId: number) =>
  `__version:bootstrap:home:notifications:user:${userId}`;

const nowMs = () => Date.now();

const toSafeVersion = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.trunc(parsed);
};

const readLocalVersion = (key: string): number | null => {
  const entry = localVersionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs()) {
    localVersionCache.delete(key);
    return null;
  }
  return entry.version;
};

const writeLocalVersion = (key: string, version: number) => {
  localVersionCache.set(key, {
    version: toSafeVersion(version),
    expiresAtMs: nowMs() + localVersionReadTtlMs,
  });
};

const getVersion = async (key: string): Promise<number> => {
  const local = readLocalVersion(key);
  if (local !== null) return local;

  const loaded = await loadFindSessionState<VersionState>({
    scope: "home",
    sessionKey: key,
    ttlSeconds: versionStoreTtlSeconds,
    initialState: {
      version: 1,
      updatedAtMs: 0,
    },
  });

  const version = toSafeVersion(loaded?.state?.version);
  writeLocalVersion(key, version);
  return version;
};

const bumpVersion = async (key: string): Promise<number> => {
  const nextVersion = Math.max(nowMs(), toSafeVersion(readLocalVersion(key) ?? 1) + 1);
  await saveFindSessionState<VersionState>({
    scope: "home",
    sessionKey: key,
    ttlSeconds: versionStoreTtlSeconds,
    state: {
      version: nextVersion,
      updatedAtMs: nowMs(),
    },
  });
  writeLocalVersion(key, nextVersion);
  return nextVersion;
};

export const getHomeContentCacheVersion = async () => {
  return getVersion(CONTENT_VERSION_KEY);
};

export const bumpHomeContentCacheVersion = async () => {
  return bumpVersion(CONTENT_VERSION_KEY);
};

export const getHomeNotificationsCacheVersion = async (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return 1;
  return getVersion(toNotificationsVersionKey(Math.trunc(userId)));
};

export const bumpHomeNotificationsCacheVersion = async (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return 1;
  return bumpVersion(toNotificationsVersionKey(Math.trunc(userId)));
};

