import {
  Request,
  Response,
  formatResponse,
  postRepository,
  reelRepository,
  serviceRepository,
  notificationRepository,
  savedRepository,
  userRepository,
} from "../_module/module";
import crypto from "crypto";
import { respondNotModifiedIfFresh } from "../../../libs/http_cache";
import * as followerRepo from "../../../repository/follower/follower_repository";
import {
  toNotificationSummary,
  toPostSummary,
  toReelSummary,
  toServiceSummary,
} from "../../../libs/summary_response";
import {
  buildServiceFeedViewerContext,
  rankServiceFeedItems,
} from "../../../libs/feed/service_feed_ranking";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../../libs/cache/find_session_store";
import {
  getHomeContentSectionVersions,
  getHomeNotificationsCacheVersion,
} from "../../../libs/cache/bootstrap_home_cache_version";
import logger from "../../../libs/logger/logger";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const homeSummaryCacheEnabled = !isTruthy(process.env.HOME_SUMMARY_CACHE_DISABLED ?? "0");
const normalizeHomeCacheTtlSeconds = (value: any, fallback = 20) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(30, Math.max(10, Math.floor(parsed)));
};
const homeSummaryCacheTtlSeconds = normalizeHomeCacheTtlSeconds(
  process.env.HOME_SUMMARY_CACHE_TTL_SECONDS ?? 20,
  20
);
const homeNotificationsCacheTtlSeconds = normalizeHomeCacheTtlSeconds(
  process.env.HOME_NOTIFICATIONS_CACHE_TTL_SECONDS ?? 10,
  10
);
const homeSummaryL1MaxEntries = Math.max(
  100,
  Number(process.env.HOME_SUMMARY_L1_MAX_ENTRIES ?? 2000) || 2000
);
const homeSummaryGuestUseExplicitSession = isTruthy(
  process.env.HOME_SUMMARY_GUEST_USE_EXPLICIT_SESSION ?? "1"
);
const homePublicSummaryBrowserMaxAgeSeconds = Math.max(
  0,
  Number(process.env.HOME_PUBLIC_SUMMARY_BROWSER_MAX_AGE_SECONDS ?? 15) || 15
);
const homePublicSummaryEdgeMaxAgeSeconds = Math.max(
  homePublicSummaryBrowserMaxAgeSeconds,
  Number(process.env.HOME_PUBLIC_SUMMARY_EDGE_MAX_AGE_SECONDS ?? 75) || 75
);
const homePublicSummaryStaleWhileRevalidateSeconds = Math.max(
  0,
  Number(process.env.HOME_PUBLIC_SUMMARY_STALE_WHILE_REVALIDATE_SECONDS ?? 180) || 180
);
const homePublicSummaryStaleIfErrorSeconds = Math.max(
  0,
  Number(process.env.HOME_PUBLIC_SUMMARY_STALE_IF_ERROR_SECONDS ?? 600) || 600
);

type HomeSummaryCacheEntry = {
  cachedAtMs: number;
  body: any | null;
};
type HomeNotificationsCacheBody = {
  limit: number;
  unreadCount: number;
  items: any[];
};
type HomeNotificationsCacheEntry = {
  cachedAtMs: number;
  body: HomeNotificationsCacheBody | null;
};
type HomeSummaryL1Entry = {
  expiresAtMs: number;
  body: any;
};

const homeSummaryL1 = new Map<string, HomeSummaryL1Entry>();
const homeSummaryInFlight = new Map<string, Promise<any>>();
const homeNotificationsInFlight = new Map<string, Promise<HomeNotificationsCacheBody>>();

const cloneCacheValue = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
};

const normalizeSize = (value: any, fallback: number, max = 10) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), max);
};

const collectPostAuthorIds = (rowsRaw: any[]): number[] =>
  (Array.isArray(rowsRaw) ? rowsRaw : [])
    .map((post: any) => Number(post?.user?.id ?? post?.userId))
    .filter((id: number) => Number.isFinite(id) && id > 0);

const collectReelCreatorIds = (rowsRaw: any[]): number[] =>
  (Array.isArray(rowsRaw) ? rowsRaw : [])
    .map((reel: any) => Number(reel?.user?.id ?? reel?.userId))
    .filter((id: number) => Number.isFinite(id) && id > 0);

const collectServiceProviderIds = (servicesRaw: any[]): number[] =>
  (Array.isArray(servicesRaw) ? servicesRaw : [])
    .map((service: any) =>
      Number(
        service?.client?.id ??
          service?.workers?.[0]?.personal_data?.id ??
          service?.offers?.[0]?.offerer?.personal_data?.id
      )
    )
    .filter((id: number) => Number.isFinite(id) && id > 0);

const toExplicitSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();
  return (queryKey || headerKey).slice(0, 128);
};

const toSessionKey = (req: Request) => {
  const explicit = toExplicitSessionKey(req);
  if (explicit) return explicit;

  const viewerId = Number((req as any)?.userId ?? 0);
  if (Number.isFinite(viewerId) && viewerId > 0) return `u:${viewerId}`;

  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  if (!ip && !userAgent) return "";

  return crypto
    .createHash("sha1")
    .update(`${ip}|${userAgent}`)
    .digest("hex")
    .slice(0, 40);
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

const setOptionalAuthDebugHeaders = (req: Request, res: Response) => {
  const requestAny: any = req as any;
  const tokenPresent = Number(requestAny?.authOptionalTokenPresent ?? 0) === 1;
  const stateRaw = String(
    requestAny?.authOptionalState ?? (requestAny?.authenticated ? "verified" : "missing")
  ).trim();
  const state = stateRaw || "missing";
  const action = String(requestAny?.authOptionalAction ?? "").trim();
  const code = String(requestAny?.authOptionalCode ?? "").trim();

  res.set("X-Auth-Optional-Token", tokenPresent ? "1" : "0");
  res.set("X-Auth-Optional-State", state);
  if (action) res.set("X-Auth-Action-Hint", action);
  if (code) res.set("X-Auth-Error-Code", code);
};

const setHomeSummaryCacheHeaders = (req: Request, res: Response) => {
  const canUsePublicCache = !isAuthenticatedRequest(req) && !hasAuthCredentialsHint(req);

  if (canUsePublicCache) {
    const browserCacheControl = [
      "public",
      `max-age=${homePublicSummaryBrowserMaxAgeSeconds}`,
      `s-maxage=${homePublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${homePublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${homePublicSummaryStaleIfErrorSeconds}`,
    ].join(", ");
    const edgeCacheControl = [
      "public",
      `s-maxage=${homePublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${homePublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${homePublicSummaryStaleIfErrorSeconds}`,
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

const hashTo = (value: string, size = 24) =>
  crypto.createHash("sha1").update(String(value ?? "")).digest("hex").slice(0, size);

const toHomeCacheAudienceKey = (req: Request, viewerId: number | null) => {
  const safeViewerId = Number(viewerId ?? 0);
  if (Number.isFinite(safeViewerId) && safeViewerId > 0) return `u:${safeViewerId}`;

  const explicit = toExplicitSessionKey(req);
  if (explicit && homeSummaryGuestUseExplicitSession) {
    return `gsk:${hashTo(explicit, 28)}`;
  }

  const ip = String(req.ip ?? "").trim();
  const userAgent = String(req.header("user-agent") ?? "").trim();
  const raw = `${ip}|${userAgent}`;
  if (!raw.replace("|", "")) return "guest";
  return `g:${hashTo(raw, 28)}`;
};

const cleanupHomeSummaryL1 = () => {
  const now = Date.now();
  for (const [key, entry] of homeSummaryL1.entries()) {
    if (entry.expiresAtMs <= now) homeSummaryL1.delete(key);
  }
  while (homeSummaryL1.size > homeSummaryL1MaxEntries) {
    const oldestKey = homeSummaryL1.keys().next().value;
    if (!oldestKey) break;
    homeSummaryL1.delete(oldestKey);
  }
};

const readHomeSummaryL1 = (cacheKey: string): any | null => {
  if (!cacheKey) return null;
  cleanupHomeSummaryL1();
  const entry = homeSummaryL1.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    homeSummaryL1.delete(cacheKey);
    return null;
  }
  return entry.body != null ? cloneCacheValue(entry.body) : null;
};

const writeHomeSummaryL1 = (cacheKey: string, body: any) => {
  if (!cacheKey || body == null) return;
  cleanupHomeSummaryL1();
  homeSummaryL1.set(cacheKey, {
    expiresAtMs: Date.now() + homeSummaryCacheTtlSeconds * 1000,
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

const parseIncludeSections = (raw: any) => {
  const defaults = new Set(["posts", "reels", "services", "notifications"]);
  const input = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!input.length) return defaults;
  return new Set(input.filter((item) => defaults.has(item)));
};

const buildHomeSummaryCacheKey = (params: {
  viewerId: number;
  cacheAudienceKey: string;
  postsVersion: number;
  reelsVersion: number;
  servicesVersion: number;
  includeKey: string;
  postsSize: number;
  reelsSize: number;
  servicesSize: number;
  notificationsLimit: number;
  includeRankingDebug: boolean;
}) => {
  const sessionSuffix = params.cacheAudienceKey || "anonymous";
  return [
    "summary:home",
    `v:${params.viewerId}`,
    `sk:${sessionSuffix}`,
    `pv:${params.postsVersion}`,
    `rv:${params.reelsVersion}`,
    `sv:${params.servicesVersion}`,
    `i:${params.includeKey}`,
    `ps:${params.postsSize}`,
    `rs:${params.reelsSize}`,
    `ss:${params.servicesSize}`,
    `nl:${params.notificationsLimit}`,
    `rd:${params.includeRankingDebug ? 1 : 0}`,
  ].join(":");
};

const buildHomeNotificationsCacheKey = (params: {
  viewerId: number;
  notificationsVersion: number;
  notificationsLimit: number;
}) => {
  return [
    "summary:home:notifications",
    `v:${params.viewerId}`,
    `nv:${params.notificationsVersion}`,
    `nl:${params.notificationsLimit}`,
  ].join(":");
};

const toHomeSummaryPayload = (
  body: any,
  authenticated: boolean,
  viewerId: number | null
) => {
  return {
    meta:
      body?.meta ??
      {
        authenticated,
        userId: viewerId,
      },
    sections:
      body?.sections && typeof body.sections === "object" ? { ...body.sections } : {},
  };
};

const readHomeSummaryCache = async (cacheKey: string): Promise<any | null> => {
  if (!homeSummaryCacheEnabled || !cacheKey) return null;
  const l1 = readHomeSummaryL1(cacheKey);
  if (l1) return l1;
  const loaded = await loadFindSessionState<HomeSummaryCacheEntry>({
    scope: "home",
    sessionKey: cacheKey,
    ttlSeconds: homeSummaryCacheTtlSeconds,
    initialState: {
      cachedAtMs: 0,
      body: null,
    },
  });
  const entry = loaded?.state;
  if (!entry?.body || !entry?.cachedAtMs) return null;
  if (Date.now() - Number(entry.cachedAtMs) > homeSummaryCacheTtlSeconds * 1000) return null;
  writeHomeSummaryL1(cacheKey, entry.body);
  return entry.body;
};

const writeHomeSummaryCache = async (cacheKey: string, body: any) => {
  if (!homeSummaryCacheEnabled || !cacheKey) return;
  writeHomeSummaryL1(cacheKey, body);
  await saveFindSessionState<HomeSummaryCacheEntry>({
    scope: "home",
    sessionKey: cacheKey,
    ttlSeconds: homeSummaryCacheTtlSeconds,
    state: {
      cachedAtMs: Date.now(),
      body,
    },
  });
};

const readHomeNotificationsCache = async (
  cacheKey: string
): Promise<HomeNotificationsCacheBody | null> => {
  if (!homeSummaryCacheEnabled || !cacheKey) return null;
  const l1 = readHomeSummaryL1(cacheKey);
  if (l1) return l1 as HomeNotificationsCacheBody;

  const loaded = await loadFindSessionState<HomeNotificationsCacheEntry>({
    scope: "home",
    sessionKey: cacheKey,
    ttlSeconds: homeNotificationsCacheTtlSeconds,
    initialState: {
      cachedAtMs: 0,
      body: null,
    },
  });
  const entry = loaded?.state;
  if (!entry?.body || !entry?.cachedAtMs) return null;
  if (Date.now() - Number(entry.cachedAtMs) > homeNotificationsCacheTtlSeconds * 1000) {
    return null;
  }
  writeHomeSummaryL1(cacheKey, entry.body);
  return entry.body;
};

const writeHomeNotificationsCache = async (
  cacheKey: string,
  body: HomeNotificationsCacheBody
) => {
  if (!homeSummaryCacheEnabled || !cacheKey) return;
  writeHomeSummaryL1(cacheKey, body);
  await saveFindSessionState<HomeNotificationsCacheEntry>({
    scope: "home",
    sessionKey: cacheKey,
    ttlSeconds: homeNotificationsCacheTtlSeconds,
    state: {
      cachedAtMs: Date.now(),
      body,
    },
  });
};

const normalizeCount = (value: any): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const toIsoDate = (value: any): string | null => {
  const parsed = new Date(value ?? "");
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const setSavedFlag = (post: any, isSaved: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", isSaved);
    post.setDataValue("isSaved", isSaved);
    post.setDataValue("saved", isSaved);
    return;
  }
  post.is_saved = isSaved;
  post.isSaved = isSaved;
  post.saved = isSaved;
};

const setSavedCount = (post: any, count: number) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("saved_count", count);
    post.setDataValue("savedCount", count);
    return;
  }
  post.saved_count = count;
  post.savedCount = count;
};

const toBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
};

const resolveOnSite = (serviceRaw: any): boolean => {
  const explicitOnSite = toBoolOrNull(serviceRaw?.on_site ?? serviceRaw?.onSite);
  if (explicitOnSite !== null) return explicitOnSite;

  const explicitRemote = toBoolOrNull(serviceRaw?.is_remote ?? serviceRaw?.isRemote);
  if (explicitRemote !== null) return !explicitRemote;

  const hasAddress = String(serviceRaw?.address ?? "").trim().length > 0;
  const hasCoordinates =
    Number.isFinite(Number(serviceRaw?.latitude)) &&
    Number.isFinite(Number(serviceRaw?.longitude));
  return hasAddress || hasCoordinates;
};

const attachSavedFlags = async (viewerIdRaw: any, posts: any[]) => {
  if (!Array.isArray(posts) || !posts.length) return;

  const viewerId = Number(viewerIdRaw ?? 0);
  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  posts.forEach((post: any) => {
    setSavedCount(post, normalizeCount((post as any)?.saves_count));
  });

  if (!Number.isFinite(viewerId) || viewerId <= 0) {
    posts.forEach((post: any) => setSavedFlag(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlag(post, savedSet.has(Number(post?.id)));
  });
};

const toHomeServiceFeedItem = (serviceRaw: any, viewerIdRaw: any) => {
  const summary = toServiceSummary(serviceRaw, viewerIdRaw);
  const onSite = resolveOnSite(serviceRaw);
  const createdAt =
    summary?.createdAt ??
    toIsoDate(serviceRaw?.service_date ?? serviceRaw?.createdAt ?? serviceRaw?.updatedAt);

  return {
    ...summary,
    on_site: onSite,
    onSite,
    is_remote: !onSite,
    isRemote: !onSite,
    createdAt,
    created_at: createdAt,
    client: serviceRaw?.client ?? null,
  };
};

const toHomeServiceResponseItem = (item: any) => {
  const { client, ...rest } = item ?? {};
  return rest;
};

const NEW_CONTENT_HOURS = 48;

const getUnifiedFeedItemAge = (item: any): number => {
  const raw = item?.createdAt ?? item?.created_at;
  if (!raw) return 9999;
  const ts = new Date(String(raw)).getTime();
  return !Number.isFinite(ts) || ts <= 0 ? 9999 : (Date.now() - ts) / 3_600_000;
};

const getNewHighlightExpiresAt = (item: any): string | null => {
  const raw = item?.createdAt ?? item?.created_at;
  if (!raw) return null;
  const ts = new Date(String(raw)).getTime();
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts + NEW_CONTENT_HOURS * 3_600_000).toISOString();
};

const sortByCreatedAtDesc = (a: any, b: any): number => {
  const tsA = new Date(String(a?.createdAt ?? a?.created_at ?? "")).getTime() || 0;
  const tsB = new Date(String(b?.createdAt ?? b?.created_at ?? "")).getTime() || 0;
  return tsB - tsA;
};

const buildUnifiedFeed = (sections: any): any[] => {
  const reels: any[] = sections?.reels?.items ?? [];
  const posts: any[] = sections?.posts?.items ?? [];
  const services: any[] = sections?.services?.items ?? [];

  const isNew = (item: any) => getUnifiedFeedItemAge(item) < NEW_CONTENT_HOURS;

  // Tier 1 — contenido nuevo (<48h): reels + posts mezclados por createdAt DESC
  const newContent = [
    ...reels.filter(isNew).map((r) => ({
      ...r,
      feed_type: "reel",
      feed_tier: "new_content",
      isNewHighlighted: true,
      newHighlightExpiresAt: getNewHighlightExpiresAt(r),
    })),
    ...posts.filter(isNew).map((p) => ({
      ...p,
      feed_type: "post",
      feed_tier: "new_content",
      isNewHighlighted: true,
      newHighlightExpiresAt: getNewHighlightExpiresAt(p),
    })),
  ].sort(sortByCreatedAtDesc);

  // Tier 2 — tarjetas de trabajo (ya filtradas por reglas de ubicación)
  const jobCards = services.map((s) => ({
    ...s,
    feed_type: "service",
    feed_tier: "job_card",
    isNewHighlighted: false,
    newHighlightExpiresAt: null,
  }));

  // Tier 3 — contenido viejo (>=48h): reels + posts mezclados por createdAt DESC
  const oldContent = [
    ...reels.filter((r) => !isNew(r)).map((r) => ({
      ...r,
      feed_type: "reel",
      feed_tier: "ranked",
      isNewHighlighted: false,
      newHighlightExpiresAt: null,
    })),
    ...posts.filter((p) => !isNew(p)).map((p) => ({
      ...p,
      feed_type: "post",
      feed_tier: "ranked",
      isNewHighlighted: false,
      newHighlightExpiresAt: null,
    })),
  ].sort(sortByCreatedAtDesc);

  return [...newContent, ...jobCards, ...oldContent];
};

export const home = async (req: Request, res: Response) => {
  try {
    const include = parseIncludeSections((req.query as any)?.include);
    const includeRankingDebug = isTruthy((req.query as any)?.ranking_debug);
    res.set("X-Ranking-Debug", includeRankingDebug ? "1" : "0");
    setOptionalAuthDebugHeaders(req, res);
    const sessionKey = toSessionKey(req);
    const viewerId = Number((req as any)?.userId ?? 0) || null;
    const cacheAudienceKey = toHomeCacheAudienceKey(req, viewerId);
    const includeNotifications = include.has("notifications") && Boolean(viewerId);
    const includeForHomeCache = new Set(include);
    includeForHomeCache.delete("notifications");

    const postsSize = normalizeSize((req.query as any)?.posts_size, 5, 10);
    const reelsSize = normalizeSize((req.query as any)?.reels_size, 6, 10);
    const servicesSize = normalizeSize((req.query as any)?.services_size, 4, 10);
    const notificationsLimit = normalizeSize((req.query as any)?.notifications_limit, 5, 10);
    const includeKey = Array.from(includeForHomeCache.values()).sort().join(",");
    const sectionVersions = await getHomeContentSectionVersions(includeForHomeCache.values());

    const cacheKey = buildHomeSummaryCacheKey({
      viewerId: Number(viewerId ?? 0) || 0,
      cacheAudienceKey,
      postsVersion: sectionVersions.posts,
      reelsVersion: sectionVersions.reels,
      servicesVersion: sectionVersions.services,
      includeKey,
      postsSize,
      reelsSize,
      servicesSize,
      notificationsLimit: 0,
      includeRankingDebug,
    });

    const authenticated = Boolean((req as any)?.authenticated && viewerId);
    let payload: any = null;
    const markPartial = (section: string) => {
      const normalized = String(section ?? "").trim().toLowerCase();
      if (!normalized) return;
      if (!payload || typeof payload !== "object") return;
      if (!payload.meta || typeof payload.meta !== "object") {
        payload.meta = { authenticated, userId: viewerId };
      }
      const meta = payload.meta as any;
      const failed = new Set<string>(
        Array.isArray(meta.failed_sections)
          ? meta.failed_sections.map((item: any) => String(item ?? "").trim().toLowerCase())
          : []
      );
      failed.add(normalized);
      meta.partial = true;
      meta.failed_sections = Array.from(failed.values()).sort();
    };

    const cachedBody = await readHomeSummaryCache(cacheKey);
    if (cachedBody && typeof cachedBody === "object") {
      res.set("X-Bootstrap-Cache", "hit");
      res.set("X-Bootstrap-Cache-TTL", String(homeSummaryCacheTtlSeconds));
      payload = toHomeSummaryPayload(cachedBody, authenticated, viewerId);
    } else {
      const summaryResult = await withSingleFlight(
        homeSummaryInFlight,
        cacheKey,
        async () => {
          const cachedWarmBody = await readHomeSummaryCache(cacheKey);
          if (cachedWarmBody && typeof cachedWarmBody === "object") {
            return toHomeSummaryPayload(cachedWarmBody, authenticated, viewerId);
          }

          const failedSections = new Set<string>();
          const servicesCandidateSize = Math.min(Math.max(servicesSize * 5, 30), 120);
          const [postsResult, reelsResult, servicesResult, viewerProfileResult] =
            await Promise.allSettled([
              includeForHomeCache.has("posts")
                ? postRepository.getsSummary(0, postsSize, req.userId, {
                    sessionKey,
                    includeRankingDebug,
                  })
                : Promise.resolve(null),
              includeForHomeCache.has("reels")
                ? reelRepository.listFeed(0, reelsSize, req.userId, false, {
                    sessionKey,
                    summary: true,
                  })
                : Promise.resolve(null),
              includeForHomeCache.has("services")
                ? serviceRepository.getFeedServicesCandidates(
                    servicesCandidateSize,
                    Number(req.userId ?? -1)
                  )
                : Promise.resolve(null),
              includeForHomeCache.has("services") && viewerId
                ? userRepository.getUserById(viewerId)
                : Promise.resolve(null),
            ]);

          const postsRaw =
            postsResult.status === "fulfilled" ? postsResult.value : null;
          const reelsRaw =
            reelsResult.status === "fulfilled" ? reelsResult.value : null;
          const servicesRaw =
            servicesResult.status === "fulfilled" ? servicesResult.value : null;
          const viewerProfileRaw =
            viewerProfileResult.status === "fulfilled" ? viewerProfileResult.value : null;

          if (includeForHomeCache.has("posts") && postsResult.status !== "fulfilled") {
            failedSections.add("posts");
          }
          if (includeForHomeCache.has("reels") && reelsResult.status !== "fulfilled") {
            failedSections.add("reels");
          }
          if (includeForHomeCache.has("services") && servicesResult.status !== "fulfilled") {
            failedSections.add("services");
          }

          const serviceRows = Array.isArray(servicesRaw) ? servicesRaw : [];
          let rankedServiceItems: any[] = [];
          if (includeForHomeCache.has("services")) {
            try {
              rankedServiceItems = rankServiceFeedItems(
                serviceRows.map((service: any) => toHomeServiceFeedItem(service, req.userId)),
                buildServiceFeedViewerContext(viewerProfileRaw),
                {
                  includeRankingDebug,
                }
              ).slice(0, servicesSize);
            } catch {
              rankedServiceItems = [];
              failedSections.add("services");
            }
          }
          const serviceById = new Map<number, any>();
          serviceRows.forEach((service: any) => {
            const id = Number(service?.id);
            if (Number.isFinite(id) && id > 0) serviceById.set(id, service);
          });

          if (includeForHomeCache.has("posts") && postsRaw?.rows) {
            try {
              await attachSavedFlags(req.userId, postsRaw.rows ?? []);
            } catch {
              failedSections.add("posts");
            }
          }

          let relationshipByUserId: Record<number, any> = {};
          try {
            relationshipByUserId = await followerRepo.getRelationshipMap(req.userId, [
              ...collectPostAuthorIds(postsRaw?.rows ?? []),
              ...collectReelCreatorIds(reelsRaw?.rows ?? []),
              ...collectServiceProviderIds(servicesRaw ?? []),
            ]);
          } catch {
            relationshipByUserId = {};
          }

          const postsFailed = failedSections.has("posts");
          const reelsFailed = failedSections.has("reels");
          const servicesFailed = failedSections.has("services");

          const freshPayload = {
            meta: {
              authenticated,
              userId: viewerId,
              partial: failedSections.size > 0,
              failed_sections: Array.from(failedSections.values()).sort(),
            },
            sections: {
              ...(includeForHomeCache.has("posts")
                ? {
                    posts: {
                      page: 0,
                      size: postsSize,
                      count: Number(postsRaw?.count ?? 0) || 0,
                      items: postsFailed
                        ? []
                        : (postsRaw?.rows ?? []).map((post: any) =>
                            toPostSummary(post, req.userId, relationshipByUserId)
                          ),
                      degraded: postsFailed,
                    },
                  }
                : {}),
              ...(includeForHomeCache.has("reels")
                ? {
                    reels: {
                      page: 0,
                      size: reelsSize,
                      count: Number(reelsRaw?.count ?? 0) || 0,
                      items: reelsFailed
                        ? []
                        : (reelsRaw?.rows ?? []).map((reel: any) =>
                            toReelSummary(reel, req.userId, relationshipByUserId)
                          ),
                      degraded: reelsFailed,
                    },
                  }
                : {}),
              ...(includeForHomeCache.has("services")
                ? {
                    services: {
                      size: servicesSize,
                      items: servicesFailed
                        ? []
                        : rankedServiceItems.map((serviceItem: any) => {
                            const serviceId = Number(serviceItem?.id);
                            const sourceRaw =
                              (Number.isFinite(serviceId) ? serviceById.get(serviceId) : null) ??
                              serviceItem;
                            const summary = toServiceSummary(
                              sourceRaw,
                              req.userId,
                              relationshipByUserId
                            ) as any;
                            if (includeRankingDebug) {
                              summary.score = serviceItem?.score ?? serviceItem?.feed_score ?? null;
                              summary.feed_score =
                                serviceItem?.feed_score ?? serviceItem?.score ?? null;
                              summary.rankingReason =
                                serviceItem?.rankingReason ?? serviceItem?.ranking_reason ?? null;
                              summary.ranking_reason =
                                serviceItem?.ranking_reason ?? serviceItem?.rankingReason ?? null;
                            }
                            return toHomeServiceResponseItem(summary);
                          }),
                      degraded: servicesFailed,
                    },
                  }
                : {}),
            },
          };

          (freshPayload.sections as any).unified_feed = buildUnifiedFeed(freshPayload.sections);

          if (failedSections.size === 0) {
            await writeHomeSummaryCache(cacheKey, freshPayload);
          }
          return toHomeSummaryPayload(freshPayload, authenticated, viewerId);
        }
      );

      res.set("X-Bootstrap-Cache", summaryResult.shared ? "coalesced" : "miss");
      res.set("X-Bootstrap-Cache-TTL", String(homeSummaryCacheTtlSeconds));
      payload = summaryResult.value;
    }

    if (includeNotifications && viewerId) {
      try {
        const notificationsVersion = await getHomeNotificationsCacheVersion(viewerId);
        const notificationsCacheKey = buildHomeNotificationsCacheKey({
          viewerId: Number(viewerId),
          notificationsVersion,
          notificationsLimit,
        });
        const cachedNotifications = await readHomeNotificationsCache(notificationsCacheKey);
        if (cachedNotifications) {
          res.set("X-Bootstrap-Notifications-Cache", "hit");
          payload.sections.notifications = cachedNotifications;
        } else {
          const notificationsResult = await withSingleFlight(
            homeNotificationsInFlight,
            notificationsCacheKey,
            async () => {
              const cachedWarmNotifications = await readHomeNotificationsCache(
                notificationsCacheKey
              );
              if (cachedWarmNotifications) return cachedWarmNotifications;

              const [notificationsRaw, unreadNotifications] = await Promise.all([
                notificationRepository.myNotificationsSummary(viewerId, {
                  limit: notificationsLimit,
                  cursor: null,
                }),
                notificationRepository.countUnreadByUser(viewerId),
              ]);
              const notificationsBody: HomeNotificationsCacheBody = {
                limit: notificationsLimit,
                unreadCount: Number(unreadNotifications ?? 0) || 0,
                items: (notificationsRaw ?? []).map((notification: any) =>
                  toNotificationSummary(notification)
                ),
              };
              await writeHomeNotificationsCache(notificationsCacheKey, notificationsBody);
              return notificationsBody;
            }
          );
          res.set(
            "X-Bootstrap-Notifications-Cache",
            notificationsResult.shared ? "coalesced" : "miss"
          );
          payload.sections.notifications = notificationsResult.value;
        }
      } catch {
        if (!payload.sections || typeof payload.sections !== "object") {
          payload.sections = {};
        }
        payload.sections.notifications = {
          limit: notificationsLimit,
          unreadCount: 0,
          items: [],
          degraded: true,
        };
        res.set("X-Bootstrap-Notifications-Cache", "error");
        markPartial("notifications");
      }
      res.set("X-Bootstrap-Notifications-Cache-TTL", String(homeNotificationsCacheTtlSeconds));
    } else {
      res.set("X-Bootstrap-Notifications-Cache", "bypass");
      res.set("X-Bootstrap-Notifications-Cache-TTL", String(homeNotificationsCacheTtlSeconds));
    }

    const isPartial = Boolean(payload?.meta?.partial);
    res.set("X-Bootstrap-Partial", isPartial ? "1" : "0");
    if (isPartial) {
      const failedSections = Array.isArray(payload?.meta?.failed_sections)
        ? payload.meta.failed_sections.map((item: any) => String(item ?? "").trim()).filter(Boolean)
        : [];
      if (failedSections.length > 0) {
        res.set("X-Bootstrap-Partial-Sections", failedSections.join(","));
      }
    }

    setHomeSummaryCacheHeaders(req, res);
    if (respondNotModifiedIfFresh(req, res, payload)) return;

    return formatResponse({
      res,
      success: true,
      body: payload,
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};
