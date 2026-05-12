import { Request, Response, formatResponse, repository } from "../_module/module";
import crypto from "crypto";
import {
  isCompactMode,
  isSummaryMode,
  toReelSummary,
  toReelSummaryCompact,
} from "../../../libs/summary_response";
import * as followerRepo from "../../../repository/follower/follower_repository";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../../libs/cache/find_session_store";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;
const reelSummaryCacheEnabled = !isTruthy(process.env.REEL_SUMMARY_CACHE_DISABLED ?? "0");
const reelSummaryCacheTtlSeconds = Math.max(
  15,
  Number(process.env.REEL_SUMMARY_CACHE_TTL_SECONDS ?? 20) || 20
);
const reelSummaryL1MaxEntries = Math.max(
  100,
  Number(process.env.REEL_SUMMARY_L1_MAX_ENTRIES ?? 2000) || 2000
);
const reelPublicSummaryBrowserMaxAgeSeconds = Math.max(
  0,
  Number(process.env.REEL_PUBLIC_SUMMARY_BROWSER_MAX_AGE_SECONDS ?? 15) || 15
);
const reelPublicSummaryEdgeMaxAgeSeconds = Math.max(
  reelPublicSummaryBrowserMaxAgeSeconds,
  Number(process.env.REEL_PUBLIC_SUMMARY_EDGE_MAX_AGE_SECONDS ?? 75) || 75
);
const reelPublicSummaryStaleWhileRevalidateSeconds = Math.max(
  0,
  Number(process.env.REEL_PUBLIC_SUMMARY_STALE_WHILE_REVALIDATE_SECONDS ?? 180) || 180
);
const reelPublicSummaryStaleIfErrorSeconds = Math.max(
  0,
  Number(process.env.REEL_PUBLIC_SUMMARY_STALE_IF_ERROR_SECONDS ?? 600) || 600
);
const reelSummaryRelationshipCacheTtlMs = Math.max(
  0,
  Number(process.env.REEL_SUMMARY_RELATIONSHIP_CACHE_TTL_MS ?? 10000) || 10000
);

type ReelSummaryCacheEntry = {
  cachedAtMs: number;
  body: any | null;
};
type ReelSummaryL1Entry = {
  expiresAtMs: number;
  body: any;
};

type ReelRelationshipFlags = {
  isFollowing: boolean;
  isFollowedBy: boolean;
  isMutual: boolean;
};

type ReelRelationshipMap = Record<number, ReelRelationshipFlags>;

type ReelRelationshipCacheEntry = {
  expiresAtMs: number;
  value: ReelRelationshipMap;
};

const reelRelationshipCache = new Map<string, ReelRelationshipCacheEntry>();
const reelSummaryL1 = new Map<string, ReelSummaryL1Entry>();
const reelSummaryInFlight = new Map<string, Promise<any>>();

const normalizeUserId = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const hasAuthCredentialsHint = (req: Request): boolean => {
  const authHeaders = [
    req.header("Authorization"),
    req.header("x-auth-token"),
    req.header("x-access-token"),
    req.header("auth_token"),
  ];
  if (authHeaders.some((value: any) => String(value ?? "").trim().length > 0)) return true;

  const query: any = req.query ?? {};
  const authQueryParams = [
    query?.urlToken,
    query?.auth_token,
    query?.authToken,
    query?.token,
  ];
  return authQueryParams.some((value: any) => String(value ?? "").trim().length > 0);
};

const isAuthenticatedRequest = (req: Request): boolean => {
  const requestAny: any = req as any;
  const userId = Number(requestAny?.userId ?? 0);
  return Boolean(requestAny?.authenticated) || (Number.isFinite(userId) && userId > 0);
};

const setReelListCacheHeaders = (req: Request, res: Response, summary: boolean) => {
  if (!summary) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Vary", "Accept-Encoding, Authorization");
    return;
  }

  const canUsePublicCache = !isAuthenticatedRequest(req) && !hasAuthCredentialsHint(req);
  if (canUsePublicCache) {
    const browserCacheControl = [
      "public",
      `max-age=${reelPublicSummaryBrowserMaxAgeSeconds}`,
      `s-maxage=${reelPublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${reelPublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${reelPublicSummaryStaleIfErrorSeconds}`,
    ].join(", ");
    const edgeCacheControl = [
      "public",
      `s-maxage=${reelPublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${reelPublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${reelPublicSummaryStaleIfErrorSeconds}`,
    ].join(", ");

    res.set("Cache-Control", browserCacheControl);
    res.set("CDN-Cache-Control", edgeCacheControl);
    res.set("Cloudflare-CDN-Cache-Control", edgeCacheControl);
    res.set("Vary", "Accept-Encoding");
    return;
  }

  res.set("Cache-Control", "private, no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("CDN-Cache-Control", "private, no-store");
  res.set("Cloudflare-CDN-Cache-Control", "private, no-store");
  res.set("Vary", "Accept-Encoding, Authorization");
};

const collectReelCreatorIds = (rowsRaw: any[]): number[] =>
  Array.from(
    new Set(
      (Array.isArray(rowsRaw) ? rowsRaw : [])
        .map((row: any) => Number(row?.user?.id ?? row?.userId))
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

const attachRelationshipAliases = (target: any, relationshipRaw: any) => {
  if (!target) return;
  const isFollowing = Boolean(relationshipRaw?.isFollowing);
  const isFollowedBy = Boolean(relationshipRaw?.isFollowedBy);
  const isMutual = isFollowing && isFollowedBy;
  const fields = {
    relationship: { isFollowing, isFollowedBy, isMutual },
    isFollowing,
    is_following: isFollowing,
    viewerFollowsUser: isFollowing,
    viewer_follows_user: isFollowing,
    isFollowedBy,
    is_followed_by: isFollowedBy,
    userFollowsViewer: isFollowedBy,
    user_follows_viewer: isFollowedBy,
    isMutual,
    is_mutual: isMutual,
  };
  if (typeof target.setDataValue === "function") {
    Object.entries(fields).forEach(([key, value]) => {
      target.setDataValue(key, value);
    });
    return;
  }
  Object.assign(target, fields);
};

const buildReelRelationshipCacheKey = (
  viewerIdRaw: any,
  creatorIdsRaw: number[]
): string => {
  const viewerId = normalizeUserId(viewerIdRaw);
  if (!viewerId) return "";
  const creatorIds = Array.from(
    new Set(
      (Array.isArray(creatorIdsRaw) ? creatorIdsRaw : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  ).sort((a, b) => a - b);
  if (!creatorIds.length) return "";
  const digest = crypto
    .createHash("sha1")
    .update(creatorIds.join(","))
    .digest("hex")
    .slice(0, 20);
  return `${viewerId}:${digest}`;
};

const readCachedReelRelationshipMap = (cacheKey: string): ReelRelationshipMap | null => {
  if (!cacheKey || reelSummaryRelationshipCacheTtlMs <= 0) return null;
  const cached = reelRelationshipCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now()) {
    reelRelationshipCache.delete(cacheKey);
    return null;
  }
  return cached.value;
};

const writeCachedReelRelationshipMap = (cacheKey: string, value: ReelRelationshipMap) => {
  if (!cacheKey || reelSummaryRelationshipCacheTtlMs <= 0) return;
  reelRelationshipCache.set(cacheKey, {
    value: { ...(value ?? {}) },
    expiresAtMs: Date.now() + reelSummaryRelationshipCacheTtlMs,
  });
};

const attachRelationshipsToReels = async (
  viewerIdRaw: any,
  rowsRaw: any[],
  options: { useCache?: boolean } = {}
) => {
  const creatorIds = collectReelCreatorIds(rowsRaw);
  const useCache = Boolean(options.useCache);
  const cacheKey = useCache ? buildReelRelationshipCacheKey(viewerIdRaw, creatorIds) : "";
  const cachedMap = cacheKey ? readCachedReelRelationshipMap(cacheKey) : null;
  const relationshipByUserId =
    cachedMap ??
    (await followerRepo.getRelationshipMap(
      viewerIdRaw,
      creatorIds
    ));
  if (!cachedMap && cacheKey) {
    writeCachedReelRelationshipMap(cacheKey, relationshipByUserId);
  }

  (Array.isArray(rowsRaw) ? rowsRaw : []).forEach((row: any) => {
    const user =
      (row as any)?.user ??
      (row as any)?.dataValues?.user ??
      (typeof (row as any)?.get === "function" ? (row as any).get("user") : null);
    const userId = Number((user as any)?.id ?? (row as any)?.userId);
    const relationship =
      relationshipByUserId[userId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(user, relationship);
  });

  return relationshipByUserId;
};

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const applyRelativeToReelComment = (comment: any, locale: AppLocale) => {
  if (!comment) return;
  const referenceDate =
    (comment as any)?.createdAt ??
    (comment as any)?.created_at ??
    null;
  const relativeTime = formatRelativeTime(referenceDate, locale);
  if (!relativeTime) return;
  setValue(comment, "relativeTime", relativeTime);
  setValue(comment, "relative_time", relativeTime);
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = normalizeUserId((req as any)?.userId);

  if (!userId) {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }

  try {
    const pushSettings = await userRepository.getPushSettings(userId);
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
      storedLanguage: pushSettings?.language,
      storedLanguageCodes: pushSettings?.language_codes,
      storedLanguageNames: pushSettings?.language_names,
    });
  } catch {
    return resolveLocale({
      preferredLanguage,
      acceptLanguage,
    });
  }
};

const toSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = queryKey || headerKey;
  const viewerId = Number((req as any)?.userId ?? 0);
  if (Number.isFinite(viewerId) && viewerId > 0) {
    // For authenticated users keep a stable key by user.
    // Volatile client session_key values (often regenerated UUIDs) break persistence.
    if (isTruthy(process.env.ORBIT_AUTH_SESSION_BY_DEVICE ?? "0") && explicit) {
      return explicit.slice(0, 128);
    }
    return `u:${viewerId}`;
  }

  if (explicit) return explicit.slice(0, 128);

  const authorization = String(req.header("authorization") ?? "").trim();
  let tokenFingerprint = "";
  if (/^bearer\s+/i.test(authorization)) {
    const token = authorization.replace(/^bearer\s+/i, "").trim();
    if (token) {
      tokenFingerprint = crypto
        .createHash("sha1")
        .update(token)
        .digest("hex")
        .slice(0, 20);
    }
  }

  if (tokenFingerprint) return `a:t:${tokenFingerprint}`;

  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  if (!ip && !userAgent) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 40);
};

const buildReelSummaryCacheKey = (params: {
  variant: "feed" | "suggested";
  page: number;
  size: number;
  viewerId: number;
  sessionKey: string;
  allowLoop: boolean;
  compact: boolean;
}) => {
  const viewerId = normalizeUserId(params.viewerId) ?? 0;
  const sessionSuffix = params.sessionKey || "anonymous";
  const loopFlag = params.allowLoop ? 1 : 0;
  const compactFlag = params.compact ? 1 : 0;
  if (viewerId <= 0) {
    return `summary:${params.variant}:public:p:${params.page}:s:${params.size}:l:${loopFlag}:cp:${compactFlag}`;
  }
  return `summary:${params.variant}:v:${viewerId}:p:${params.page}:s:${params.size}:l:${loopFlag}:cp:${compactFlag}:sk:${sessionSuffix}`;
};

const cloneCacheValue = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
};

const cleanupReelSummaryL1 = () => {
  const now = Date.now();
  for (const [key, entry] of reelSummaryL1.entries()) {
    if (entry.expiresAtMs <= now) reelSummaryL1.delete(key);
  }
  while (reelSummaryL1.size > reelSummaryL1MaxEntries) {
    const oldestKey = reelSummaryL1.keys().next().value;
    if (!oldestKey) break;
    reelSummaryL1.delete(oldestKey);
  }
};

const readReelSummaryL1 = (cacheKey: string): any | null => {
  if (!cacheKey) return null;
  cleanupReelSummaryL1();
  const entry = reelSummaryL1.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    reelSummaryL1.delete(cacheKey);
    return null;
  }
  return entry.body != null ? cloneCacheValue(entry.body) : null;
};

const writeReelSummaryL1 = (cacheKey: string, body: any) => {
  if (!cacheKey || body == null) return;
  cleanupReelSummaryL1();
  reelSummaryL1.set(cacheKey, {
    expiresAtMs: Date.now() + reelSummaryCacheTtlSeconds * 1000,
    body: cloneCacheValue(body),
  });
};

const withSingleFlight = async <T>(
  store: Map<string, Promise<T>>,
  key: string,
  task: () => Promise<T>
): Promise<{ value: T; shared: boolean }> => {
  if (!key) return { value: await task(), shared: false };

  const current = store.get(key);
  if (current) return { value: await current, shared: true };

  const promise = (async () => task())();
  store.set(key, promise);

  try {
    return { value: await promise, shared: false };
  } finally {
    if (store.get(key) === promise) {
      store.delete(key);
    }
  }
};

const readReelSummaryCache = async (cacheKey: string): Promise<any | null> => {
  if (!reelSummaryCacheEnabled || !cacheKey) return null;
  const l1 = readReelSummaryL1(cacheKey);
  if (l1) return l1;
  const loaded = await loadFindSessionState<ReelSummaryCacheEntry>({
    scope: "orbit",
    sessionKey: cacheKey,
    ttlSeconds: reelSummaryCacheTtlSeconds,
    initialState: {
      cachedAtMs: 0,
      body: null,
    },
  });
  const entry = loaded?.state;
  if (!entry?.body || !entry?.cachedAtMs) return null;
  if (Date.now() - Number(entry.cachedAtMs) > reelSummaryCacheTtlSeconds * 1000) return null;
  writeReelSummaryL1(cacheKey, entry.body);
  return entry.body;
};

const writeReelSummaryCache = async (cacheKey: string, body: any) => {
  if (!reelSummaryCacheEnabled || !cacheKey) return;
  writeReelSummaryL1(cacheKey, body);
  await saveFindSessionState<ReelSummaryCacheEntry>({
    scope: "orbit",
    sessionKey: cacheKey,
    ttlSeconds: reelSummaryCacheTtlSeconds,
    state: {
      cachedAtMs: Date.now(),
      body,
    },
  });
};

type ProfileReelCursorState = {
  reelId: number | null;
  videoUid: string | null;
  updatedAt: number;
};

type ProfileFeedLockState = {
  targetUserId: number | null;
  updatedAt: number;
};

const PROFILE_REEL_CURSOR_TTL_MS = Math.max(
  60_000,
  Number(process.env.PROFILE_REEL_CURSOR_TTL_MS ?? 20 * 60 * 1000) || 20 * 60 * 1000
);
const PROFILE_REEL_CURSOR_TTL_SECONDS = Math.max(
  60,
  Math.floor(PROFILE_REEL_CURSOR_TTL_MS / 1000)
);
const PROFILE_REEL_CURSOR_INITIAL_STATE: ProfileReelCursorState = {
  reelId: null,
  videoUid: null,
  updatedAt: 0,
};
const PROFILE_FEED_LOCK_TTL_MS = Math.max(
  30_000,
  Number(process.env.PROFILE_FEED_LOCK_TTL_MS ?? 90_000) || 90_000
);
const PROFILE_FEED_LOCK_TTL_SECONDS = Math.max(
  30,
  Math.floor(PROFILE_FEED_LOCK_TTL_MS / 1000)
);
const PROFILE_FEED_LOCK_INITIAL_STATE: ProfileFeedLockState = {
  targetUserId: null,
  updatedAt: 0,
};

const buildProfileReelCursorKey = (req: Request, targetUserId: number | null) => {
  if (!targetUserId) return "";
  const viewerId = normalizeUserId((req as any)?.userId) ?? 0;
  const sessionKey = toSessionKey(req) || "anonymous";
  return `${viewerId}:${targetUserId}:${sessionKey}`;
};

const buildProfileReelSessionKey = (key: string) =>
  key ? `profile_reel_cursor:${key}` : "";

const buildProfileFeedLockSessionKey = (key: string) =>
  key ? `profile_feed_lock:${key}` : "";

const toExplicitSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();
  const explicit = queryKey || headerKey;
  return explicit ? explicit.slice(0, 128) : "";
};

const toClientFingerprint = (req: Request) => {
  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  if (!ip && !userAgent) return "";
  return crypto
    .createHash("sha1")
    .update(`${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 40);
};

const buildProfileFeedLockKeys = (req: Request) => {
  const viewerId = normalizeUserId((req as any)?.userId);
  const explicitSession = toExplicitSessionKey(req);
  const fingerprint = toClientFingerprint(req);
  // Keep profile-lock state isolated per authenticated user to avoid
  // cross-account leakage on the same device/fingerprint.
  if (viewerId) {
    return [`${viewerId}:${explicitSession || fingerprint || "anonymous"}`];
  }

  const keys: string[] = [];
  if (explicitSession) keys.push(`anon_explicit:${explicitSession}`);
  if (fingerprint) keys.push(`anon_fp:${fingerprint}`);
  return [...new Set(keys.filter((key) => key.length > 0))];
};

const readProfileReelCursor = async (
  key: string
): Promise<ProfileReelCursorState | null> => {
  if (!key) return null;
  const sessionKey = buildProfileReelSessionKey(key);
  if (!sessionKey) return null;
  const loaded = await loadFindSessionState<ProfileReelCursorState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_REEL_CURSOR_TTL_SECONDS,
    initialState: PROFILE_REEL_CURSOR_INITIAL_STATE,
  });
  const state = loaded?.state ?? PROFILE_REEL_CURSOR_INITIAL_STATE;
  if (!state?.reelId && !state?.videoUid) {
    return null;
  }
  return state;
};

const writeProfileReelCursor = async (key: string, reel: any) => {
  if (!key || !reel) return;
  const sessionKey = buildProfileReelSessionKey(key);
  if (!sessionKey) return;
  const reelId = normalizeUserId((reel as any)?.id);
  const videoUid = String(
    (reel as any)?.video_uid ?? (reel as any)?.videoUid ?? ""
  ).trim();
  await saveFindSessionState<ProfileReelCursorState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_REEL_CURSOR_TTL_SECONDS,
    state: {
      reelId: reelId ?? null,
      videoUid: videoUid || null,
      updatedAt: Date.now(),
    },
  });
};

const clearProfileReelCursor = async (key: string) => {
  if (!key) return;
  const sessionKey = buildProfileReelSessionKey(key);
  if (!sessionKey) return;
  await saveFindSessionState<ProfileReelCursorState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_REEL_CURSOR_TTL_SECONDS,
    state: {
      ...PROFILE_REEL_CURSOR_INITIAL_STATE,
      updatedAt: Date.now(),
    },
  });
};

const readProfileFeedLock = async (
  key: string
): Promise<ProfileFeedLockState | null> => {
  if (!key) return null;
  const sessionKey = buildProfileFeedLockSessionKey(key);
  if (!sessionKey) return null;
  const loaded = await loadFindSessionState<ProfileFeedLockState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_FEED_LOCK_TTL_SECONDS,
    initialState: PROFILE_FEED_LOCK_INITIAL_STATE,
  });
  const state = loaded?.state ?? PROFILE_FEED_LOCK_INITIAL_STATE;
  if (!state?.targetUserId) return null;
  return state;
};

const writeProfileFeedLock = async (
  key: string,
  targetUserId: number | null
) => {
  if (!key || !targetUserId) return;
  const sessionKey = buildProfileFeedLockSessionKey(key);
  if (!sessionKey) return;
  await saveFindSessionState<ProfileFeedLockState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_FEED_LOCK_TTL_SECONDS,
    state: {
      targetUserId,
      updatedAt: Date.now(),
    },
  });
};

const clearProfileFeedLock = async (key: string) => {
  if (!key) return;
  const sessionKey = buildProfileFeedLockSessionKey(key);
  if (!sessionKey) return;
  await saveFindSessionState<ProfileFeedLockState>({
    scope: "orbit",
    sessionKey,
    ttlSeconds: PROFILE_FEED_LOCK_TTL_SECONDS,
    state: {
      ...PROFILE_FEED_LOCK_INITIAL_STATE,
      updatedAt: Date.now(),
    },
  });
};

const readProfileFeedLockForRequest = async (req: Request) => {
  const keys = buildProfileFeedLockKeys(req);
  if (!keys.length) return null;

  const states = await Promise.all(keys.map((key) => readProfileFeedLock(key)));
  const validStates = states.filter((state): state is ProfileFeedLockState => Boolean(state));
  if (!validStates.length) return null;

  validStates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return validStates[0] ?? null;
};

const writeProfileFeedLockForRequest = async (req: Request, targetUserId: number | null) => {
  if (!targetUserId) return;
  const keys = buildProfileFeedLockKeys(req);
  if (!keys.length) return;
  await Promise.all(keys.map((key) => writeProfileFeedLock(key, targetUserId)));
};

const clearProfileFeedLockForRequest = async (req: Request) => {
  const keys = buildProfileFeedLockKeys(req);
  if (!keys.length) return;
  await Promise.all(keys.map((key) => clearProfileFeedLock(key)));
};

const shouldLoopFeed = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return true;
};

const fetchFeedWithLoopFallback = async ({
  page,
  size,
  viewerId,
  suggested,
  summary,
  sessionKey,
  allowLoop,
}: {
  page: number;
  size: number;
  viewerId: any;
  suggested: boolean;
  summary: boolean;
  sessionKey: string;
  allowLoop: boolean;
}) => {
  const requestedPage = page;
  let data = await repository.listFeed(page, size, viewerId, suggested, {
    sessionKey,
    summary,
  });
  let looped = false;

  if (allowLoop && page > 0) {
    const totalCount = Number(data?.count ?? 0) || 0;
    if (totalCount > 0) {
      const totalPages = Math.max(1, Math.ceil(totalCount / Math.max(1, size)));
      const effectivePage = page % totalPages;

      if (effectivePage !== page) {
        data = await repository.listFeed(effectivePage, size, viewerId, suggested, {
          sessionKey,
          summary,
        });
        looped = true;
      } else if (!Array.isArray(data?.rows) || data.rows.length === 0) {
        data = await repository.listFeed(0, size, viewerId, suggested, {
          sessionKey,
          summary,
        });
        looped = true;
      }
    }
  }

  return { data, requestedPage, looped };
};

export const reels_feed = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const compact = summary && isCompactMode((req.query as any)?.compact);
    const canUseSummaryServerCache =
      summary && !isAuthenticatedRequest(req) && !hasAuthCredentialsHint(req);
    setReelListCacheHeaders(req, res, summary);
    const allowLoop = shouldLoopFeed(
      (req.query as any)?.loop ?? (req.query as any)?.repeat
    );
    const sessionKey = toSessionKey(req);
    const viewerId = Number((req as any).userId ?? 0) || 0;
    const cacheKey =
      summary && canUseSummaryServerCache
        ? buildReelSummaryCacheKey({
            variant: "feed",
            page,
            size,
            viewerId,
            sessionKey,
            allowLoop,
            compact,
          })
        : "";
    if (summary) {
      res.set("X-Summary-Cache-TTL", String(reelSummaryCacheTtlSeconds));
    }
    if (summary && cacheKey) {
      const cachedBody = await readReelSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
    } else if (summary) {
      res.set("X-Summary-Cache", "bypass");
    }
    const buildResponseBody = async () => {
      const { data, requestedPage, looped } = await fetchFeedWithLoopFallback({
        page,
        size,
        viewerId: (req as any).userId,
        suggested: false,
        summary,
        sessionKey,
        allowLoop,
      });
      if (shouldLogFindProfile()) {
        console.log(
          `[find/orbit/endpoint] ${JSON.stringify({
            endpoint: "/api/v1/reel",
            page: Number(requestedPage) || 0,
            size: Number(size) || 15,
            viewerId: Number((req as any).userId ?? 0) || null,
            totalCount: Number(data?.count ?? 0),
            served: Array.isArray(data?.rows) ? data.rows.length : 0,
            looped,
            totalLatencyMs: round3(nowMs() - startedAtMs),
          })}`
        );
      }
      const relationshipByUserId = await attachRelationshipsToReels(
        (req as any).userId,
        data.rows ?? [],
        { useCache: summary }
      );

      return {
        page: data.page,
        requestedPage,
        size: data.size,
        count: data.count,
        looped,
        reels: summary
          ? (data.rows ?? []).map((row: any) => {
              const reelSummary = toReelSummary(
                row,
                (req as any).userId,
                relationshipByUserId
              );
              return compact ? toReelSummaryCompact(reelSummary) : reelSummary;
            })
          : data.rows,
      };
    };

    if (summary && cacheKey) {
      const result = await withSingleFlight(reelSummaryInFlight, cacheKey, async () => {
        const warm = await readReelSummaryCache(cacheKey);
        if (warm) return warm;
        const computed = await buildResponseBody();
        await writeReelSummaryCache(cacheKey, computed);
        return computed;
      });
      res.set("X-Summary-Cache", result.shared ? "coalesced" : "miss");
      return formatResponse({
        res,
        success: true,
        body: result.value,
      });
    }

    const responseBody = await buildResponseBody();

    return formatResponse({
      res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_suggested = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const compact = summary && isCompactMode((req.query as any)?.compact);
    const canUseSummaryServerCache =
      summary && !isAuthenticatedRequest(req) && !hasAuthCredentialsHint(req);
    setReelListCacheHeaders(req, res, summary);
    const allowLoop = shouldLoopFeed(
      (req.query as any)?.loop ?? (req.query as any)?.repeat
    );
    const sessionKey = toSessionKey(req);
    const viewerId = Number((req as any).userId ?? 0) || 0;
    const profileFeedLock = await readProfileFeedLockForRequest(req);
    if (profileFeedLock?.targetUserId) {
      const lockedData = await repository.listByUser(
        String(profileFeedLock.targetUserId),
        0,
        size,
        (req as any).userId,
        { loop: true }
      );
      const lockedRows = Array.isArray(lockedData?.rows) ? lockedData.rows : [];
      const profileCursorKey = buildProfileReelCursorKey(req, profileFeedLock.targetUserId);
      if (lockedRows.length > 0) {
        await writeProfileReelCursor(profileCursorKey, lockedRows[0]);
        const relationshipByUserId = await attachRelationshipsToReels(
          (req as any).userId,
          lockedRows,
          { useCache: summary }
        );

        return formatResponse({
          res,
          success: true,
          body: {
            page: 0,
            requestedPage: page,
            size: lockedData?.size ?? size,
            count: Number(lockedData?.count ?? 0),
            looped: allowLoop,
            reels: summary
              ? lockedRows.map((row: any) => {
                  const reelSummary = toReelSummary(
                    row,
                    (req as any).userId,
                    relationshipByUserId
                  );
                  return compact ? toReelSummaryCompact(reelSummary) : reelSummary;
                })
              : lockedRows,
            profileLocked: true,
            profileUserId: profileFeedLock.targetUserId,
            source: "profile_lock",
          },
        });
      }

      await Promise.all([
        clearProfileFeedLockForRequest(req),
        clearProfileReelCursor(profileCursorKey),
      ]);
    }

    const startedAtMs = nowMs();
    const cacheKey =
      summary && canUseSummaryServerCache
        ? buildReelSummaryCacheKey({
            variant: "suggested",
            page,
            size,
            viewerId,
            sessionKey,
            allowLoop,
            compact,
          })
        : "";
    if (summary) {
      res.set("X-Summary-Cache-TTL", String(reelSummaryCacheTtlSeconds));
    }
    if (summary && cacheKey) {
      const cachedBody = await readReelSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
    } else if (summary) {
      res.set("X-Summary-Cache", "bypass");
    }
    const buildResponseBody = async () => {
      const { data, requestedPage, looped } = await fetchFeedWithLoopFallback({
        page,
        size,
        viewerId: (req as any).userId,
        suggested: true,
        summary,
        sessionKey,
        allowLoop,
      });
      if (shouldLogFindProfile()) {
        console.log(
          `[find/orbit/endpoint] ${JSON.stringify({
            endpoint: "/api/v1/reel/suggested",
            page: Number(requestedPage) || 0,
            size: Number(size) || 15,
            viewerId: Number((req as any).userId ?? 0) || null,
            totalCount: Number(data?.count ?? 0),
            served: Array.isArray(data?.rows) ? data.rows.length : 0,
            looped,
            totalLatencyMs: round3(nowMs() - startedAtMs),
          })}`
        );
      }
      const relationshipByUserId = await attachRelationshipsToReels(
        (req as any).userId,
        data.rows ?? [],
        { useCache: summary }
      );

      return {
        page: data.page,
        requestedPage,
        size: data.size,
        count: data.count,
        looped,
        reels: summary
          ? (data.rows ?? []).map((row: any) => {
              const reelSummary = toReelSummary(
                row,
                (req as any).userId,
                relationshipByUserId
              );
              return compact ? toReelSummaryCompact(reelSummary) : reelSummary;
            })
          : data.rows,
      };
    };

    if (summary && cacheKey) {
      const result = await withSingleFlight(reelSummaryInFlight, cacheKey, async () => {
        const warm = await readReelSummaryCache(cacheKey);
        if (warm) return warm;
        const computed = await buildResponseBody();
        await writeReelSummaryCache(cacheKey, computed);
        return computed;
      });
      res.set("X-Summary-Cache", result.shared ? "coalesced" : "miss");
      return formatResponse({
        res,
        success: true,
        body: result.value,
      });
    }

    const responseBody = await buildResponseBody();

    return formatResponse({
      res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const my_reels = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const data = await repository.listMine(req.userId, page, size);
    await attachRelationshipsToReels((req as any).userId, data.rows ?? []);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const user_reels = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const targetUserId = normalizeUserId(id);
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    let afterReelId =
      (req.query as any)?.after_reel_id ??
      (req.query as any)?.afterReelId ??
      (req.query as any)?.current_reel_id ??
      (req.query as any)?.currentReelId ??
      null;
    let afterVideoUid =
      (req.query as any)?.after_video_uid ??
      (req.query as any)?.afterVideoUid ??
      (req.query as any)?.current_video_uid ??
      (req.query as any)?.currentVideoUid ??
      null;
    // Profile reels should start from newest item unless the client explicitly
    // asks for looping behavior.
    const loop = shouldLoopFeed(
      (req.query as any)?.loop ?? (req.query as any)?.repeat ?? false
    );
    if (loop) {
      await writeProfileFeedLockForRequest(req, targetUserId);
    } else {
      await clearProfileFeedLockForRequest(req);
    }
    const clientProvidedCursor = Boolean(
      String(afterReelId ?? "").trim() || String(afterVideoUid ?? "").trim()
    );
    const profileCursorKey = buildProfileReelCursorKey(req, targetUserId);
    // Never resume from stored cursor on the initial profile page.
    // This guarantees profile opens from newest Orbit and avoids stale-cursor skips.
    if (loop && page > 0 && !clientProvidedCursor) {
      const cursor = await readProfileReelCursor(profileCursorKey);
      if (cursor?.reelId) afterReelId = cursor.reelId;
      else if (cursor?.videoUid) afterVideoUid = cursor.videoUid;
    }
    let data = await repository.listByUser(id, page, size, (req as any).userId, {
      afterReelId,
      afterVideoUid,
      loop,
    });

    if (loop && clientProvidedCursor && data?.cursorSupplied && data?.cursorMatched === false) {
      const cursor = await readProfileReelCursor(profileCursorKey);
      if (cursor?.reelId || cursor?.videoUid) {
        const recovered = await repository.listByUser(id, page, size, (req as any).userId, {
          afterReelId: cursor?.reelId ?? null,
          afterVideoUid: cursor?.videoUid ?? null,
          loop,
        });
        if (!recovered?.notFound && Array.isArray(recovered?.rows) && recovered.rows.length > 0) {
          data = recovered;
        }
      }
    }

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    if (loop && Array.isArray(data?.rows) && data.rows.length > 0) {
      await writeProfileReelCursor(profileCursorKey, data.rows[0]);
    } else if (!loop) {
      await clearProfileReelCursor(profileCursorKey);
    }
    await attachRelationshipsToReels((req as any).userId, data.rows ?? []);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reels_saved = async (req: Request, res: Response) => {
  try {
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 15) || 15, 1), 20);
    const data = await repository.listSaved(req.userId, page, size);
    await attachRelationshipsToReels((req as any).userId, data.rows ?? []);

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        reels: data.rows,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_by_id = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const profileFeedLock = await readProfileFeedLockForRequest(req);
    const reel = await repository.getById(id, (req as any).userId);
    if (profileFeedLock?.targetUserId) {
      const reelOwnerId =
        normalizeUserId((reel as any)?.userId) ??
        normalizeUserId((reel as any)?.user?.id);
      const belongsToLockedProfile =
        Boolean(reel) && Boolean(reelOwnerId) && reelOwnerId === profileFeedLock.targetUserId;

      if (belongsToLockedProfile && reel) {
        const profileCursorKey = buildProfileReelCursorKey(req, profileFeedLock.targetUserId);
        await writeProfileReelCursor(profileCursorKey, reel);
        return formatResponse({
          res,
          success: true,
          body: { reel },
        });
      }

      const profileCursorKey = buildProfileReelCursorKey(req, profileFeedLock.targetUserId);
      const cursor = await readProfileReelCursor(profileCursorKey);
      const recovered = await repository.listByUser(
        String(profileFeedLock.targetUserId),
        0,
        1,
        (req as any).userId,
        {
          afterReelId: cursor?.reelId ?? null,
          afterVideoUid: cursor?.videoUid ?? null,
          loop: true,
        }
      );
      const fallbackReel = Array.isArray(recovered?.rows) ? recovered.rows[0] : null;

      if (fallbackReel) {
        await attachRelationshipsToReels((req as any).userId, [fallbackReel]);
        await writeProfileReelCursor(profileCursorKey, fallbackReel);
        return formatResponse({
          res,
          success: true,
          body: {
            reel: fallbackReel,
            profileLockedFallback: true,
            requestedReelId: normalizeUserId(id) ?? null,
            profileUserId: profileFeedLock.targetUserId,
          },
        });
      }

      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }
    await attachRelationshipsToReels((req as any).userId, [reel]);

    return formatResponse({
      res,
      success: true,
      body: { reel },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_comments = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(0, Number((req.query as any)?.page ?? 0) || 0);
    const size = Math.min(Math.max(Number((req.query as any)?.size ?? 20) || 20, 1), 20);
    const locale = await resolveRequestLocale(req);
    const data = await repository.listComments(id, page, size);

    if (data.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        page: data.page,
        size: data.size,
        count: data.count,
        comments: (data.rows ?? []).map((comment: any) => {
          applyRelativeToReelComment(comment, locale);
          return comment;
        }),
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const reel_download = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const reel = await repository.getById(id, (req as any).userId);

    if (!reel) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const isOwner = Number((reel as any).userId) === Number((req as any).userId || 0);
    if (!(reel as any).allow_download && !isOwner) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "download not allowed",
      });
    }

    const downloadUrl = repository.getDownloadUrl(reel);
    if (!downloadUrl) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "download url not available",
      });
    }

    const shouldRedirect = String((req.query as any)?.redirect ?? "0") === "1";
    if (shouldRedirect) {
      return res.redirect(downloadUrl);
    }

    return formatResponse({
      res,
      success: true,
      body: {
        reelId: Number((reel as any).id),
        download_url: downloadUrl,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
