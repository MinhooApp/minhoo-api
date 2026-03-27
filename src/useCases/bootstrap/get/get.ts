import {
  Request,
  Response,
  formatResponse,
  postRepository,
  reelRepository,
  serviceRepository,
  notificationRepository,
  savedRepository,
} from "../_module/module";
import crypto from "crypto";
import { respondNotModifiedIfFresh, setCacheControl } from "../../../libs/http_cache";
import {
  toNotificationSummary,
  toPostSummary,
  toReelSummary,
  toServiceSummary,
} from "../../../libs/summary_response";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../../libs/cache/find_session_store";

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

const normalizeSize = (value: any, fallback: number, max = 10) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(parsed)), max);
};

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
  return entry.body ?? null;
};

const writeHomeSummaryL1 = (cacheKey: string, body: any) => {
  if (!cacheKey || body == null) return;
  cleanupHomeSummaryL1();
  homeSummaryL1.set(cacheKey, {
    expiresAtMs: Date.now() + homeSummaryCacheTtlSeconds * 1000,
    body,
  });
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
  includeKey: string;
  postsSize: number;
  reelsSize: number;
  servicesSize: number;
  notificationsLimit: number;
}) => {
  const sessionSuffix = params.cacheAudienceKey || "anonymous";
  return [
    "summary:home",
    `v:${params.viewerId}`,
    `sk:${sessionSuffix}`,
    `i:${params.includeKey}`,
    `ps:${params.postsSize}`,
    `rs:${params.reelsSize}`,
    `ss:${params.servicesSize}`,
    `nl:${params.notificationsLimit}`,
  ].join(":");
};

const buildHomeNotificationsCacheKey = (params: {
  viewerId: number;
  notificationsLimit: number;
}) => {
  return [
    "summary:home:notifications",
    `v:${params.viewerId}`,
    `nl:${params.notificationsLimit}`,
  ].join(":");
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

const setSavedFlag = (post: any, isSaved: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", isSaved);
    return;
  }
  post.is_saved = isSaved;
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

export const home = async (req: Request, res: Response) => {
  try {
    const include = parseIncludeSections((req.query as any)?.include);
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

    const cacheKey = buildHomeSummaryCacheKey({
      viewerId: Number(viewerId ?? 0) || 0,
      cacheAudienceKey,
      includeKey,
      postsSize,
      reelsSize,
      servicesSize,
      notificationsLimit: 0,
    });

    let payload: any = null;
    const cachedBody = await readHomeSummaryCache(cacheKey);
    if (cachedBody && typeof cachedBody === "object") {
      res.set("X-Bootstrap-Cache", "hit");
      res.set("X-Bootstrap-Cache-TTL", String(homeSummaryCacheTtlSeconds));
      payload = {
        meta:
          (cachedBody as any).meta ??
          {
            authenticated: Boolean((req as any)?.authenticated && viewerId),
            userId: viewerId,
          },
        sections:
          (cachedBody as any).sections && typeof (cachedBody as any).sections === "object"
            ? { ...(cachedBody as any).sections }
            : {},
      };
    } else {
      res.set("X-Bootstrap-Cache", "miss");
      res.set("X-Bootstrap-Cache-TTL", String(homeSummaryCacheTtlSeconds));

      const [postsRaw, reelsRaw, servicesRaw] = await Promise.all([
        includeForHomeCache.has("posts")
          ? postRepository.getsSummary(0, postsSize, req.userId, { sessionKey })
          : Promise.resolve(null),
        includeForHomeCache.has("reels")
          ? reelRepository.listFeed(0, reelsSize, req.userId, false, {
              sessionKey,
              summary: true,
            })
          : Promise.resolve(null),
        includeForHomeCache.has("services")
          ? serviceRepository.getsSummary(servicesSize)
          : Promise.resolve(null),
      ]);

      await attachSavedFlags(req.userId, postsRaw?.rows ?? []);

      payload = {
        meta: {
          authenticated: Boolean((req as any)?.authenticated && viewerId),
          userId: viewerId,
        },
        sections: {
          ...(includeForHomeCache.has("posts")
            ? {
                posts: {
                  page: 0,
                  size: postsSize,
                  count: Number(postsRaw?.count ?? 0) || 0,
                  items: (postsRaw?.rows ?? []).map((post: any) =>
                    toPostSummary(post, req.userId)
                  ),
                },
              }
            : {}),
          ...(includeForHomeCache.has("reels")
            ? {
                reels: {
                  page: 0,
                  size: reelsSize,
                  count: Number(reelsRaw?.count ?? 0) || 0,
                  items: (reelsRaw?.rows ?? []).map((reel: any) => toReelSummary(reel)),
                },
              }
            : {}),
          ...(includeForHomeCache.has("services")
            ? {
                services: {
                  size: servicesSize,
                  items: (servicesRaw ?? []).map((service: any) => toServiceSummary(service)),
                },
              }
            : {}),
        },
      };

      await writeHomeSummaryCache(cacheKey, payload);
    }

    if (includeNotifications && viewerId) {
      const notificationsCacheKey = buildHomeNotificationsCacheKey({
        viewerId: Number(viewerId),
        notificationsLimit,
      });
      const cachedNotifications = await readHomeNotificationsCache(notificationsCacheKey);
      if (cachedNotifications) {
        res.set("X-Bootstrap-Notifications-Cache", "hit");
        payload.sections.notifications = cachedNotifications;
      } else {
        res.set("X-Bootstrap-Notifications-Cache", "miss");
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
        payload.sections.notifications = notificationsBody;
        await writeHomeNotificationsCache(notificationsCacheKey, notificationsBody);
      }
      res.set("X-Bootstrap-Notifications-Cache-TTL", String(homeNotificationsCacheTtlSeconds));
    } else {
      res.set("X-Bootstrap-Notifications-Cache", "bypass");
      res.set("X-Bootstrap-Notifications-Cache-TTL", String(homeNotificationsCacheTtlSeconds));
    }

    setCacheControl(res, {
      visibility: viewerId ? "private" : "public",
      maxAgeSeconds: homeSummaryCacheTtlSeconds,
      staleWhileRevalidateSeconds: 30,
      staleIfErrorSeconds: 60,
    });
    if (respondNotModifiedIfFresh(req, res, payload)) return;

    return formatResponse({
      res,
      success: true,
      body: payload,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
