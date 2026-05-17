import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import crypto from "crypto";
import * as savedRepository from "../../../repository/saved/saved_repository";
import Like from "../../../_models/like/like";
import * as followerRepo from "../../../repository/follower/follower_repository";
import { isSummaryMode, toPostSummary } from "../../../libs/summary_response";
import * as userRepository from "../../../repository/user/user_repository";
import { AppLocale, resolveLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../../libs/cache/find_session_store";
import logger from "../../../libs/logger/logger";

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};

const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;
const POST_AUTH_SESSION_BY_DEVICE =
  isTruthy(process.env.POST_AUTH_SESSION_BY_DEVICE ?? "0");
const postSummaryCacheEnabled = !isTruthy(process.env.POST_SUMMARY_CACHE_DISABLED ?? "0");
const postSummaryCacheTtlSeconds = Math.max(
  15,
  Number(process.env.POST_SUMMARY_CACHE_TTL_SECONDS ?? 20) || 20
);
const postSummaryL1MaxEntries = Math.max(
  100,
  Number(process.env.POST_SUMMARY_L1_MAX_ENTRIES ?? 2000) || 2000
);
const postPublicSummaryBrowserMaxAgeSeconds = Math.max(
  0,
  Number(process.env.POST_PUBLIC_SUMMARY_BROWSER_MAX_AGE_SECONDS ?? 15) || 15
);
const postPublicSummaryEdgeMaxAgeSeconds = Math.max(
  postPublicSummaryBrowserMaxAgeSeconds,
  Number(process.env.POST_PUBLIC_SUMMARY_EDGE_MAX_AGE_SECONDS ?? 75) || 75
);
const postPublicSummaryStaleWhileRevalidateSeconds = Math.max(
  0,
  Number(process.env.POST_PUBLIC_SUMMARY_STALE_WHILE_REVALIDATE_SECONDS ?? 180) || 180
);
const postPublicSummaryStaleIfErrorSeconds = Math.max(
  0,
  Number(process.env.POST_PUBLIC_SUMMARY_STALE_IF_ERROR_SECONDS ?? 600) || 600
);
const postSummaryRelationshipCacheTtlMs = Math.max(
  0,
  Number(process.env.POST_SUMMARY_RELATIONSHIP_CACHE_TTL_MS ?? 10000) || 10000
);
const postSummaryRelationshipCacheAuthEnabled = isTruthy(
  process.env.POST_SUMMARY_RELATIONSHIP_CACHE_AUTH_ENABLED ?? "0"
);

type PostSummaryCacheEntry = {
  cachedAtMs: number;
  body: any | null;
};
type PostSummaryL1Entry = {
  expiresAtMs: number;
  body: any;
};

type PostRelationshipFlags = {
  isFollowing: boolean;
  isFollowedBy: boolean;
  isMutual: boolean;
};

type PostRelationshipMap = Record<number, PostRelationshipFlags>;

type PostRelationshipCacheEntry = {
  expiresAtMs: number;
  value: PostRelationshipMap;
};

const postRelationshipCache = new Map<string, PostRelationshipCacheEntry>();
const postSummaryL1 = new Map<string, PostSummaryL1Entry>();
const postSummaryInFlight = new Map<string, Promise<any>>();

const toSessionKey = (req: Request) => {
  const queryKey = String(
    (req.query as any)?.session_key ?? (req.query as any)?.sessionKey ?? ""
  ).trim();
  const headerKey = String(req.header("x-session-key") ?? "").trim();

  const explicit = queryKey || headerKey;
  const viewerId = Number((req as any)?.userId ?? 0);
  if (Number.isFinite(viewerId) && viewerId > 0) {
    // Keep authenticated feed state stable by user.
    // Volatile client session_key values can break paging continuity and cause repeats.
    if (POST_AUTH_SESSION_BY_DEVICE && explicit) return explicit.slice(0, 128);
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

const buildPostSummaryCacheKey = (params: {
  variant: "feed" | "suggested";
  page: number;
  size: number;
  viewerId: number;
  sessionKey: string;
  includeRankingDebug: boolean;
}) => {
  const viewerId = normalizeUserId(params.viewerId) ?? 0;
  if (viewerId <= 0) {
    return `summary:${params.variant}:public:p:${params.page}:s:${params.size}:rd:${
      params.includeRankingDebug ? 1 : 0
    }`;
  }
  const sessionSuffix = params.sessionKey || "anonymous";
  return `summary:${params.variant}:v:${viewerId}:p:${params.page}:s:${params.size}:sk:${sessionSuffix}:rd:${
    params.includeRankingDebug ? 1 : 0
  }`;
};

const cloneCacheValue = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
};

const cleanupPostSummaryL1 = () => {
  const now = Date.now();
  for (const [key, entry] of postSummaryL1.entries()) {
    if (entry.expiresAtMs <= now) postSummaryL1.delete(key);
  }
  while (postSummaryL1.size > postSummaryL1MaxEntries) {
    const oldestKey = postSummaryL1.keys().next().value;
    if (!oldestKey) break;
    postSummaryL1.delete(oldestKey);
  }
};

const readPostSummaryL1 = (cacheKey: string): any | null => {
  if (!cacheKey) return null;
  cleanupPostSummaryL1();
  const entry = postSummaryL1.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    postSummaryL1.delete(cacheKey);
    return null;
  }
  return entry.body != null ? cloneCacheValue(entry.body) : null;
};

const writePostSummaryL1 = (cacheKey: string, body: any) => {
  if (!cacheKey || body == null) return;
  cleanupPostSummaryL1();
  postSummaryL1.set(cacheKey, {
    expiresAtMs: Date.now() + postSummaryCacheTtlSeconds * 1000,
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

const readPostSummaryCache = async (cacheKey: string): Promise<any | null> => {
  if (!postSummaryCacheEnabled || !cacheKey) return null;
  const l1 = readPostSummaryL1(cacheKey);
  if (l1) return l1;
  const loaded = await loadFindSessionState<PostSummaryCacheEntry>({
    scope: "post",
    sessionKey: cacheKey,
    ttlSeconds: postSummaryCacheTtlSeconds,
    initialState: {
      cachedAtMs: 0,
      body: null,
    },
  });
  const entry = loaded?.state;
  if (!entry?.body || !entry?.cachedAtMs) return null;
  if (Date.now() - Number(entry.cachedAtMs) > postSummaryCacheTtlSeconds * 1000) return null;
  writePostSummaryL1(cacheKey, entry.body);
  return entry.body;
};

const writePostSummaryCache = async (cacheKey: string, body: any) => {
  if (!postSummaryCacheEnabled || !cacheKey) return;
  writePostSummaryL1(cacheKey, body);
  await saveFindSessionState<PostSummaryCacheEntry>({
    scope: "post",
    sessionKey: cacheKey,
    ttlSeconds: postSummaryCacheTtlSeconds,
    state: {
      cachedAtMs: Date.now(),
      body,
    },
  });
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

const setPostListCacheHeaders = (req: Request, res: Response, summary: boolean) => {
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
      `max-age=${postPublicSummaryBrowserMaxAgeSeconds}`,
      `s-maxage=${postPublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${postPublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${postPublicSummaryStaleIfErrorSeconds}`,
    ].join(", ");
    const edgeCacheControl = [
      "public",
      `s-maxage=${postPublicSummaryEdgeMaxAgeSeconds}`,
      `stale-while-revalidate=${postPublicSummaryStaleWhileRevalidateSeconds}`,
      `stale-if-error=${postPublicSummaryStaleIfErrorSeconds}`,
    ].join(", ");

    res.set("Cache-Control", browserCacheControl);
    res.set("CDN-Cache-Control", edgeCacheControl);
    res.set("Cloudflare-CDN-Cache-Control", edgeCacheControl);
    res.set("Vary", "Accept-Encoding, Authorization");
    return;
  }

  res.set("Cache-Control", "private, no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("CDN-Cache-Control", "private, no-store");
  res.set("Cloudflare-CDN-Cache-Control", "private, no-store");
  res.set("Vary", "Accept-Encoding, Authorization");
};

const normalizeUserId = (value: any): number | null => {
  const userId = Number(value);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return userId;
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
    post.setDataValue("isSaved", isSaved);
    return;
  }
  post.is_saved = isSaved;
  post.isSaved = isSaved;
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

const setLikedFlag = (post: any, isLiked: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_liked", isLiked);
    post.setDataValue("isLiked", isLiked);
    post.setDataValue("isLike", isLiked);
    post.setDataValue("is_like", isLiked);
    post.setDataValue("liked", isLiked);
    post.setDataValue("is_starred", isLiked);
    post.setDataValue("isStarred", isLiked);
    post.setDataValue("starred", isLiked);
    return;
  }
  post.is_liked = isLiked;
  post.isLiked = isLiked;
  post.isLike = isLiked;
  post.is_like = isLiked;
  post.liked = isLiked;
  post.is_starred = isLiked;
  post.isStarred = isLiked;
  post.starred = isLiked;
};

const setValue = (target: any, key: string, value: any) => {
  if (!target) return;
  if (typeof target.setDataValue === "function") {
    target.setDataValue(key, value);
    return;
  }
  target[key] = value;
};

const applyRelativeToComment = (comment: any, locale: AppLocale) => {
  if (!comment) return;
  const referenceDate =
    (comment as any)?.created_date ??
    (comment as any)?.createdAt ??
    (comment as any)?.created_at ??
    null;
  const relativeTime = formatRelativeTime(referenceDate, locale);
  if (!relativeTime) return;
  setValue(comment, "relativeTime", relativeTime);
  setValue(comment, "relative_time", relativeTime);
};

const applyRelativeToPostComments = (post: any, locale: AppLocale) => {
  if (!post) return;

  const comments =
    Array.isArray((post as any)?.comments) ? (post as any).comments : [];
  if (!Array.isArray(comments) || comments.length === 0) return;

  comments.forEach((comment: any) => applyRelativeToComment(comment, locale));
  setValue(post, "comments", comments);
};

const applyRelativeToPostsComments = (posts: any[], locale: AppLocale) => {
  if (!Array.isArray(posts)) return;
  posts.forEach((post: any) => applyRelativeToPostComments(post, locale));
};

const resolveRequestLocale = async (req: Request): Promise<AppLocale> => {
  const preferredLanguage =
    (req.query as any)?.language ??
    (req.query as any)?.lang ??
    req.header("x-app-language") ??
    req.header("x-language") ??
    req.header("x-lang");
  const acceptLanguage = req.header("accept-language");
  const userId = normalizeUserId(req.userId);

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

const attachSavedFlags = async (viewerIdRaw: any, posts: any[]) => {
  if (!Array.isArray(posts) || !posts.length) return;

  const viewerId = normalizeUserId(viewerIdRaw);
  const postIds = posts
    .map((post: any) => Number(post?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  posts.forEach((post: any) => {
    setSavedCount(post, normalizeCount((post as any)?.saves_count));
  });

  if (!viewerId) {
    posts.forEach((post: any) => setSavedFlag(post, false));
    return;
  }

  const savedSet = await savedRepository.getSavedPostIdSet(viewerId, postIds);
  posts.forEach((post: any) => {
    setSavedFlag(post, savedSet.has(Number(post?.id)));
  });
};

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
    Object.entries(fields).forEach(([key, value]) => target.setDataValue(key, value));
    return;
  }

  Object.assign(target, fields);
};

const collectPostAuthorIds = (postsRaw: any[]): number[] =>
  Array.from(
    new Set(
      (Array.isArray(postsRaw) ? postsRaw : [])
        .map((post: any) => Number(post?.user?.id ?? post?.userId))
        .filter((id: number) => Number.isFinite(id) && id > 0)
    )
  );

const buildPostRelationshipCacheKey = (
  viewerIdRaw: any,
  authorIdsRaw: number[]
): string => {
  const viewerId = normalizeUserId(viewerIdRaw);
  if (!viewerId) return "";
  const authorIds = Array.from(
    new Set(
      (Array.isArray(authorIdsRaw) ? authorIdsRaw : [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  ).sort((a, b) => a - b);
  if (!authorIds.length) return "";
  const digest = crypto
    .createHash("sha1")
    .update(authorIds.join(","))
    .digest("hex")
    .slice(0, 20);
  return `${viewerId}:${digest}`;
};

const readCachedPostRelationshipMap = (cacheKey: string): PostRelationshipMap | null => {
  if (!cacheKey || postSummaryRelationshipCacheTtlMs <= 0) return null;
  const cached = postRelationshipCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now()) {
    postRelationshipCache.delete(cacheKey);
    return null;
  }
  return cached.value;
};

const writeCachedPostRelationshipMap = (
  cacheKey: string,
  value: PostRelationshipMap
) => {
  if (!cacheKey || postSummaryRelationshipCacheTtlMs <= 0) return;
  postRelationshipCache.set(cacheKey, {
    value: { ...(value ?? {}) },
    expiresAtMs: Date.now() + postSummaryRelationshipCacheTtlMs,
  });
};

const attachRelationshipsToPostAuthors = async (
  viewerIdRaw: any,
  postsRaw: any[],
  options: { useCache?: boolean } = {}
) => {
  const authorIds = collectPostAuthorIds(postsRaw);
  const viewerId = normalizeUserId(viewerIdRaw);
  const useCacheRequested = Boolean(options.useCache);
  const canUseCacheForViewer =
    !viewerId || postSummaryRelationshipCacheAuthEnabled;
  const useCache = useCacheRequested && canUseCacheForViewer;
  const cacheKey = useCache ? buildPostRelationshipCacheKey(viewerIdRaw, authorIds) : "";
  const cachedMap = cacheKey ? readCachedPostRelationshipMap(cacheKey) : null;
  const relationshipByUserId =
    cachedMap ??
    (await followerRepo.getRelationshipMap(
      viewerIdRaw,
      authorIds
    ));
  if (!cachedMap && cacheKey) {
    writeCachedPostRelationshipMap(cacheKey, relationshipByUserId);
  }

  (Array.isArray(postsRaw) ? postsRaw : []).forEach((post: any) => {
    const user =
      (post as any)?.user ??
      (post as any)?.dataValues?.user ??
      (typeof (post as any)?.get === "function" ? (post as any).get("user") : null);
    const userId = Number((user as any)?.id ?? (post as any)?.userId);
    const relationship =
      relationshipByUserId[userId] ??
      ({ isFollowing: false, isFollowedBy: false, isMutual: false } as const);
    attachRelationshipAliases(user, relationship);
  });

  return relationshipByUserId;
};

export const gets = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(Math.max(Number(req.query.size ?? 10) || 10, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const includeRankingDebug = isTruthy((req.query as any)?.ranking_debug);
    const canUseSummaryServerCache =
      summary &&
      !includeRankingDebug &&
      !isAuthenticatedRequest(req) &&
      !hasAuthCredentialsHint(req);
    setPostListCacheHeaders(req, res, summary);
    setOptionalAuthDebugHeaders(req, res);
    res.set("X-Ranking-Debug", includeRankingDebug ? "1" : "0");
    const sessionKey = toSessionKey(req);
    const viewerId = Number(req.userId ?? 0) || 0;
    const cacheKey =
      summary && canUseSummaryServerCache
        ? buildPostSummaryCacheKey({
            variant: "feed",
            page,
            size,
            viewerId,
            sessionKey,
            includeRankingDebug,
          })
        : "";
    if (summary) {
      res.set("X-Summary-Cache-TTL", String(postSummaryCacheTtlSeconds));
    }
    if (summary && cacheKey) {
      const cachedBody = await readPostSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
    } else if (summary) {
      res.set("X-Summary-Cache", "bypass");
    }
    const buildResponseBody = async () => {
      const posts = await (summary ? repository.getsSummary : repository.gets)(
        page,
        size,
        req.userId,
        {
          sessionKey,
          includeRankingDebug,
        }
      );
      let relationshipByUserId: Record<
        number,
        { isFollowing: boolean; isFollowedBy: boolean; isMutual: boolean }
      > = {};
      if (summary) {
        const [, relationshipMap] = await Promise.all([
          attachSavedFlags(req.userId, posts.rows),
          attachRelationshipsToPostAuthors(req.userId, posts.rows ?? [], {
            useCache: true,
          }),
        ]);
        relationshipByUserId = relationshipMap ?? {};
      } else {
        await attachSavedFlags(req.userId, posts.rows);
      }
      if (!summary) {
        const locale = await resolveRequestLocale(req);
        applyRelativeToPostsComments(posts.rows, locale);
      }
      if (shouldLogFindProfile()) {
        console.log(
          `[find/post/endpoint] ${JSON.stringify({
            endpoint: "/api/v1/post",
            page: Number(page) || 0,
            size: Number(size) || 10,
            viewerId: Number(req.userId ?? 0) || null,
            totalCount: Number(posts?.count ?? 0),
            served: Array.isArray(posts?.rows) ? posts.rows.length : 0,
            totalLatencyMs: round3(nowMs() - startedAtMs),
          })}`
        );
      }
      if (!summary) {
        relationshipByUserId = await attachRelationshipsToPostAuthors(
          req.userId,
          posts.rows ?? []
        );
      }

      return {
        page,
        size,
        count: posts.count,
        posts: summary
          ? (posts.rows ?? []).map((post: any) =>
              toPostSummary(post, req.userId, relationshipByUserId)
            )
          : posts.rows,
      };
    };

    if (summary && cacheKey) {
      const result = await withSingleFlight(postSummaryInFlight, cacheKey, async () => {
        const warm = await readPostSummaryCache(cacheKey);
        if (warm) return warm;
        const computed = await buildResponseBody();
        await writePostSummaryCache(cacheKey, computed);
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
      res: res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const getsSuggested = async (req: Request, res: Response) => {
  try {
    const startedAtMs = nowMs();
    const page = Math.max(0, Number(req.query.page ?? 0) || 0);
    const size = Math.min(Math.max(Number(req.query.size ?? 10) || 10, 1), 20);
    const summary = isSummaryMode((req.query as any)?.summary);
    const includeRankingDebug = isTruthy((req.query as any)?.ranking_debug);
    const canUseSummaryServerCache =
      summary &&
      !includeRankingDebug &&
      !isAuthenticatedRequest(req) &&
      !hasAuthCredentialsHint(req);
    setPostListCacheHeaders(req, res, summary);
    setOptionalAuthDebugHeaders(req, res);
    res.set("X-Ranking-Debug", includeRankingDebug ? "1" : "0");
    const sessionKey = toSessionKey(req);
    const viewerId = Number(req.userId ?? 0) || 0;
    const cacheKey =
      summary && canUseSummaryServerCache
        ? buildPostSummaryCacheKey({
            variant: "suggested",
            page,
            size,
            viewerId,
            sessionKey,
            includeRankingDebug,
          })
        : "";
    if (summary) {
      res.set("X-Summary-Cache-TTL", String(postSummaryCacheTtlSeconds));
    }
    if (summary && cacheKey) {
      const cachedBody = await readPostSummaryCache(cacheKey);
      if (cachedBody) {
        res.set("X-Summary-Cache", "hit");
        return formatResponse({ res, success: true, body: cachedBody });
      }
    } else if (summary) {
      res.set("X-Summary-Cache", "bypass");
    }
    const buildResponseBody = async () => {
      const posts = await (summary ? repository.getsSuggestedSummary : repository.getsSuggested)(
        page,
        size,
        req.userId,
        {
          sessionKey,
          includeRankingDebug,
        }
      );
      let relationshipByUserId: Record<
        number,
        { isFollowing: boolean; isFollowedBy: boolean; isMutual: boolean }
      > = {};
      if (summary) {
        const [, relationshipMap] = await Promise.all([
          attachSavedFlags(req.userId, posts.rows),
          attachRelationshipsToPostAuthors(req.userId, posts.rows ?? [], {
            useCache: true,
          }),
        ]);
        relationshipByUserId = relationshipMap ?? {};
      } else {
        await attachSavedFlags(req.userId, posts.rows);
      }
      if (!summary) {
        const locale = await resolveRequestLocale(req);
        applyRelativeToPostsComments(posts.rows, locale);
      }
      if (shouldLogFindProfile()) {
        console.log(
          `[find/post/endpoint] ${JSON.stringify({
            endpoint: "/api/v1/post/suggested",
            page: Number(page) || 0,
            size: Number(size) || 10,
            viewerId: Number(req.userId ?? 0) || null,
            totalCount: Number(posts?.count ?? 0),
            served: Array.isArray(posts?.rows) ? posts.rows.length : 0,
            totalLatencyMs: round3(nowMs() - startedAtMs),
          })}`
        );
      }
      if (!summary) {
        relationshipByUserId = await attachRelationshipsToPostAuthors(
          req.userId,
          posts.rows ?? []
        );
      }

      return {
        page,
        size,
        count: posts.count,
        posts: summary
          ? (posts.rows ?? []).map((post: any) =>
              toPostSummary(post, req.userId, relationshipByUserId)
            )
          : posts.rows,
      };
    };

    if (summary && cacheKey) {
      const result = await withSingleFlight(postSummaryInFlight, cacheKey, async () => {
        const warm = await readPostSummaryCache(cacheKey);
        if (warm) return warm;
        const computed = await buildResponseBody();
        await writePostSummaryCache(cacheKey, computed);
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
      res: res,
      success: true,
      body: responseBody,
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const get = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const locale = await resolveRequestLocale(req);
    const post = await repository.get(id, req.userId);
    await attachRelationshipsToPostAuthors(req.userId, [post].filter(Boolean) as any[]);
    if (post) {
      const postId = Number(post.id);
      const saveCount = normalizeCount((post as any)?.saves_count);
      setSavedCount(post, saveCount);

      const viewerId = normalizeUserId(req.userId);
      if (!viewerId) {
        setSavedFlag(post, false);
        setLikedFlag(post, false);
      } else {
        const [isSaved, likeRow] = await Promise.all([
          savedRepository.isPostSavedByUser(viewerId, postId),
          Like.findOne({
            where: {
              userId: viewerId,
              postId,
            },
            attributes: ["id"],
          }),
        ]);
        setSavedFlag(post, isSaved);
        setLikedFlag(post, Boolean(likeRow));
      }

      applyRelativeToPostComments(post, locale);
    }

    return formatResponse({ res: res, success: true, body: { post: post } });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};
