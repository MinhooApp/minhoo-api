import Post from "../../_models/post/post";
import Like from "../../_models/like/like";
import { postInclude } from "./post_include";
import MediaPost from "../../_models/post/media_post";
import PostReport from "../../_models/post/post_report";
import { IndexHints, Op, Sequelize, UniqueConstraintError } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";
import Comment from "../../_models/comment/comment";
import { createHmac } from "crypto";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../libs/cache/find_session_store";
import { autoDisableUserByImpersonationReports } from "../user/user_repository";
import { attachActiveOrbitStateToUsers } from "../reel/orbit_ring_projection";
import {
  attachHashtagsToRows,
  normalizeHashtagsForContent,
  syncHashtagsForContent,
} from "../hashtag/hashtag_repository";
import {
  calculateFeedScore,
  FeedContentKind,
  FeedLanguageTier,
  FeedLocationTier,
  FeedRankingReason,
} from "../../libs/feed/feed_relevance";

import { whereNotBlockedExists } from "../user/block_where";

const excludeKeys = ["createdAt", "updatedAt"];
const excludedCommentCountSql =
  "(SELECT COUNT(1) FROM comments c USE INDEX (idx_comments_post_visible_created) WHERE c.postId = `post`.`id` AND c.is_delete = 0)";
const commentCountAttribute = [
  Sequelize.literal(excludedCommentCountSql),
  "comments_count",
] as const;
const candidateCommentCountAttribute = Sequelize.literal(excludedCommentCountSql);
const candidateMediaCountAttribute = Sequelize.literal(
  "(SELECT COUNT(1) FROM mediapost m USE INDEX (idx_mediapost_post_isimg) WHERE m.postId = `post`.`id`)"
);
const candidateVideoCountAttribute = Sequelize.literal(
  "(SELECT COUNT(1) FROM mediapost m USE INDEX (idx_mediapost_post_isimg) WHERE m.postId = `post`.`id` AND m.is_img = 0)"
);

const POST_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const POST_CREATOR_COOLDOWN = 8;
const POST_MAX_TOPIC_STREAK = 4;
const POST_MAX_FORMAT_STREAK = 2;
const POST_TOPK_SHUFFLE_WINDOW = 50;
const POST_STABLE_FEED_MAX_IDS = Math.max(
  200,
  Number(process.env.POST_STABLE_FEED_MAX_IDS ?? 1200) || 1200
);
const POST_SUMMARY_SESSION_STATE_ENABLED =
  String(process.env.POST_SUMMARY_SESSION_STATE_ENABLED ?? "1").trim() === "1";
const POST_SUMMARY_VIEWER_CONTEXT_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.POST_SUMMARY_VIEWER_CONTEXT_CACHE_TTL_MS ?? 20000) || 20000
);
const POST_FEED_TOTAL_COUNT_CACHE_TTL_MS = Math.max(
  0,
  Number(process.env.POST_FEED_TOTAL_COUNT_CACHE_TTL_MS ?? 15000) || 15000
);
const POST_REPORT_AUTO_DELETE_THRESHOLD = Math.max(
  15,
  Number(process.env.POST_REPORT_AUTO_DELETE_THRESHOLD ?? 15) || 15
);
const IMPERSONATION_REPORT_REASON = "impersonation_or_identity_fraud";
const MEDIA_ACCESS_TOKEN_QUERY_KEY = "sat";
const MEDIA_ACCESS_TOKEN_TTL_SECONDS = Math.max(
  30,
  Number(process.env.MEDIA_ACCESS_TOKEN_TTL_SECONDS ?? 10 * 60) || 10 * 60
);

type SignedMediaKind = "audio" | "document" | "video_key" | "video_uid" | "image_id";

type PostFeedOptions = {
  sessionKey?: any;
  includeRankingDebug?: boolean;
};

type PostBucket = "interest" | "social" | "trending" | "local" | "exploration";
type PostSessionState = {
  updatedAt: number;
  seenPostIds: number[];
  recentCreatorIds: number[];
  recentTopicIds: number[];
  recentFormats: string[];
  creatorImpressions: Record<string, number>;
  stableFeedIds: number[];
};
type PostViewerContext = {
  followedCreatorIds: Set<number>;
  interestCategoryIds: Set<number>;
  cityId: number | null;
  stateId: number | null;
  countryId: number | null;
  primaryLanguageCode: string | null;
  secondaryLanguageCodes: Set<string>;
};
type PostCandidate = {
  row: any;
  id: number;
  creatorId: number;
  categoryId: number;
  format: string;
  bucket: PostBucket;
  localScore: number;
  feedScore: number;
  seenInSession: boolean;
  qualityPassed: boolean;
  finalScore: number;
  rankingReason: FeedRankingReason;
  scoreBreakdown: {
    affinity: number;
    dwellProxy: number;
    freshness: number;
    social: number;
    quality: number;
    exploration: number;
    novelty: number;
    trending: number;
    local: number;
    weightedBase: number;
    creatorPenalty: number;
    topicPenalty: number;
    formatPenalty: number;
    fatiguePenalty: number;
    lowQualityPenalty: number;
    newPostBoost: number;
    relevanceBase: number;
    behavioralScore: number;
    locationPoints: number;
    languagePoints: number;
    contentTypePoints: number;
    recencyPoints: number;
    ownPostBoostPoints: number;
  };
  excludedReason?: string;
};

type FeedTotalCountCacheEntry = {
  count: number;
  expiresAtMs: number;
};

type PostViewerContextCacheEntry = {
  expiresAtMs: number;
  context: PostViewerContext;
};

const postFeedTotalCountCache = new Map<string, FeedTotalCountCacheEntry>();
const postViewerContextCache = new Map<number, PostViewerContextCacheEntry>();

const readCachedPostFeedTotalCount = (key: string): number | null => {
  if (!key || POST_FEED_TOTAL_COUNT_CACHE_TTL_MS <= 0) return null;
  const cached = postFeedTotalCountCache.get(key);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now()) {
    postFeedTotalCountCache.delete(key);
    return null;
  }
  return Number.isFinite(cached.count) ? Math.max(0, Math.floor(cached.count)) : null;
};

const writeCachedPostFeedTotalCount = (key: string, count: number) => {
  if (!key || POST_FEED_TOTAL_COUNT_CACHE_TTL_MS <= 0) return;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  postFeedTotalCountCache.set(key, {
    count: safeCount,
    expiresAtMs: Date.now() + POST_FEED_TOTAL_COUNT_CACHE_TTL_MS,
  });
};

const clonePostViewerContext = (context: PostViewerContext): PostViewerContext => ({
  followedCreatorIds: new Set<number>(Array.from(context.followedCreatorIds.values())),
  interestCategoryIds: new Set<number>(Array.from(context.interestCategoryIds.values())),
  cityId: context.cityId,
  stateId: context.stateId,
  countryId: context.countryId,
  primaryLanguageCode: context.primaryLanguageCode ?? null,
  secondaryLanguageCodes: new Set<string>(
    Array.from((context.secondaryLanguageCodes ?? new Set<string>()).values())
  ),
});

const readCachedPostViewerContext = (viewerId: number | null): PostViewerContext | null => {
  if (!viewerId || POST_SUMMARY_VIEWER_CONTEXT_CACHE_TTL_MS <= 0) return null;
  const cached = postViewerContextCache.get(viewerId);
  if (!cached) return null;
  if (cached.expiresAtMs <= Date.now()) {
    postViewerContextCache.delete(viewerId);
    return null;
  }
  return clonePostViewerContext(cached.context);
};

const writeCachedPostViewerContext = (viewerId: number | null, context: PostViewerContext) => {
  if (!viewerId || POST_SUMMARY_VIEWER_CONTEXT_CACHE_TTL_MS <= 0) return;
  postViewerContextCache.set(viewerId, {
    context: clonePostViewerContext(context),
    expiresAtMs: Date.now() + POST_SUMMARY_VIEWER_CONTEXT_CACHE_TTL_MS,
  });
};

const isTruthy = (value: any) => {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
};
const shouldLogFindDebug = () => isTruthy(process.env.FIND_RANKING_DEBUG);
const shouldLogFindProfile = () => isTruthy(process.env.FIND_RANKING_PROFILE);
const shouldCollectFindProfile = () => shouldLogFindDebug() || shouldLogFindProfile();
const getFindDebugMaxItems = () => {
  const n = Number(process.env.FIND_RANKING_DEBUG_MAX_ITEMS ?? 120);
  if (!Number.isFinite(n) || n <= 0) return 120;
  return Math.min(500, Math.floor(n));
};
const round3 = (value: number) => Math.round(Number(value) * 1000) / 1000;

type PostDbQueryStat = {
  label: string;
  ms: number;
};

type PostFindProfiler = {
  enabled: boolean;
  startedAtMs: number;
  dbQueries: PostDbQueryStat[];
  rerankMs: number;
  sessionLoadMs: number;
  sessionSaveMs: number;
  sessionLoadBackend: "redis" | "memory" | null;
  sessionSaveBackend: "redis" | "memory" | null;
};

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

const createPostFindProfiler = (): PostFindProfiler => ({
  enabled: shouldCollectFindProfile(),
  startedAtMs: nowMs(),
  dbQueries: [],
  rerankMs: 0,
  sessionLoadMs: 0,
  sessionSaveMs: 0,
  sessionLoadBackend: null,
  sessionSaveBackend: null,
});

const withPostDbProfile = async <T>(
  profiler: PostFindProfiler | null | undefined,
  label: string,
  fn: () => Promise<T>
): Promise<T> => {
  if (!profiler?.enabled) return fn();
  const startedAtMs = nowMs();
  const result = await fn();
  profiler.dbQueries.push({
    label,
    ms: nowMs() - startedAtMs,
  });
  return result;
};
const toCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const clamp01 = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const normalizeSessionToken = (value: any): string => {
  return String(value ?? "")
    .trim()
    .replace(/[^\w\-:.]/g, "")
    .slice(0, 128);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

const normalizeLimit = (value: any, fallback = 10, max = 40) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
};

const pushUniqueLimited = (list: any[], value: any, maxLength: number) => {
  if (value === undefined || value === null || value === "") return;
  const existingIndex = list.findIndex((item) => item === value);
  if (existingIndex >= 0) list.splice(existingIndex, 1);
  list.unshift(value);
  if (list.length > maxLength) list.length = maxLength;
};

const hashString = (input: string) => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
};

const parseJsonArray = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  if (typeof value === "object") return [value];
  return [value];
};

const toUniqueNumbers = (values: any[]) => {
  const unique = new Set<number>();
  values.forEach((value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) unique.add(Math.floor(n));
  });
  return Array.from(unique.values());
};

const normalizeLanguageCode = (value: any): string | null => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!raw) return null;
  const token = raw.split("-")[0];
  if (!token) return null;
  if (!/^[a-z]{2,8}$/.test(token)) return null;
  return token;
};

const toUniqueLanguageCodes = (values: any[]) => {
  const unique = new Set<string>();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const code = normalizeLanguageCode(value);
    if (code) unique.add(code);
  });
  return Array.from(unique.values());
};

const toPlain = (row: any) =>
  row && typeof row.toJSON === "function" ? row.toJSON() : row;

const setRowValue = (row: any, key: string, value: any) => {
  if (!row) return;
  if (typeof row.setDataValue === "function") {
    row.setDataValue(key, value);
    return;
  }
  row[key] = value;
};

const applyPostHashtags = async (posts: any[]) => {
  await attachHashtagsToRows({
    rows: Array.isArray(posts) ? posts : [],
    contentType: "post",
  });
};

const applyCommentHashtags = async (comments: any[]) => {
  await attachHashtagsToRows({
    rows: Array.isArray(comments) ? comments : [],
    contentType: "comment",
  });
};

const refreshPostRowMediaLinks = (post: any) => {
  if (!post) return;

  const setField = (row: any, field: "url" | "media_url", value: string) => {
    if (!row) return;
    if (typeof row?.setDataValue === "function") {
      row.setDataValue(field, value);
      return;
    }
    row[field] = value;
  };

  const postMediaRaw = Array.isArray((post as any)?.post_media)
    ? (post as any).post_media
    : [];
  postMediaRaw.forEach((media: any) => {
    const original = String(media?.url ?? "").trim();
    if (!original) return;
    const refreshed = refreshSignedMediaUrl(original);
    if (refreshed !== original) setField(media, "url", refreshed);
  });

  const commentsRaw = Array.isArray((post as any)?.comments) ? (post as any).comments : [];
  commentsRaw.forEach((comment: any) => {
    const original = String(comment?.media_url ?? "").trim();
    if (!original) return;
    const refreshed = refreshSignedMediaUrl(original);
    if (refreshed !== original) setField(comment, "media_url", refreshed);
  });
};

type MediaItem = { url: string; is_img: boolean };

const toBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const getMediaAccessSigningSecret = () =>
  String(
    process.env.MEDIA_ACCESS_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      process.env.SECRETORPRIVATEKEY ??
      ""
  ).trim();

const normalizeImageId = (value: any): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._-]{6,255}$/.test(normalized)) return null;
  return normalized;
};

const normalizeVideoUid = (value: any): string | null => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-f0-9]{32}$/i.test(normalized)) return null;
  return normalized.toLowerCase();
};

const normalizeStorageKey = (value: any): string | null => {
  const decoded = decodeURIComponent(String(value ?? "").trim());
  if (!decoded) return null;
  if (!/^[a-zA-Z0-9/_.,@-]{2,512}$/.test(decoded)) return null;
  return decoded;
};

const buildMediaAccessToken = (kind: SignedMediaKind, resourceKey: string): string | null => {
  const secret = getMediaAccessSigningSecret();
  const key = String(resourceKey ?? "").trim();
  if (!secret || !key) return null;
  const exp = Math.floor(Date.now() / 1000) + MEDIA_ACCESS_TOKEN_TTL_SECONDS;
  const payload = `${kind}:${key}:${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${exp}.${toBase64Url(signature)}`;
};

const rebuildUrlLikeInput = (rawUrl: string, parsed: URL): string => {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return trimmed;
  const query = parsed.searchParams.toString();
  const pathWithQuery = query ? `${parsed.pathname}?${query}` : parsed.pathname;
  if (/^https?:\/\//i.test(trimmed)) {
    return `${parsed.protocol}//${parsed.host}${pathWithQuery}`;
  }
  return pathWithQuery;
};

const removeMediaAccessTokenFromUrl = (rawUrl: string): string => {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed || !trimmed.includes(MEDIA_ACCESS_TOKEN_QUERY_KEY)) return trimmed;

  try {
    const parsed = new URL(trimmed, "http://local");
    if (!String(parsed.pathname ?? "").includes("/api/v1/media/")) return trimmed;
    parsed.searchParams.delete(MEDIA_ACCESS_TOKEN_QUERY_KEY);
    return rebuildUrlLikeInput(trimmed, parsed);
  } catch {
    return trimmed;
  }
};

const refreshSignedMediaUrl = (rawUrl: string): string => {
  const canonicalUrl = removeMediaAccessTokenFromUrl(rawUrl);
  const trimmed = String(canonicalUrl ?? "").trim();
  if (!trimmed) return trimmed;

  try {
    const parsed = new URL(trimmed, "http://local");
    const pathname = String(parsed.pathname ?? "").trim().toLowerCase();

    let kind: SignedMediaKind | null = null;
    let resourceKey: string | null = null;

    if (pathname === "/api/v1/media/image/play") {
      kind = "image_id";
      resourceKey = normalizeImageId(parsed.searchParams.get("id"));
    } else if (pathname === "/api/v1/media/video/play") {
      const key = normalizeStorageKey(parsed.searchParams.get("key"));
      if (key) {
        kind = "video_key";
        resourceKey = key;
      } else {
        const uidRaw = String(parsed.searchParams.get("uid") ?? "").trim();
        const uid = normalizeVideoUid(uidRaw);
        if (uid) {
          kind = "video_uid";
          resourceKey = uid;
        } else {
          const fallbackKey = normalizeStorageKey(uidRaw);
          if (fallbackKey) {
            kind = "video_key";
            resourceKey = fallbackKey;
          }
        }
      }
    } else if (pathname === "/api/v1/media/audio/play") {
      kind = "audio";
      resourceKey = normalizeStorageKey(parsed.searchParams.get("key"));
    } else if (pathname === "/api/v1/media/document/download") {
      kind = "document";
      resourceKey = normalizeStorageKey(parsed.searchParams.get("key"));
    }

    if (!kind || !resourceKey) return trimmed;

    const token = buildMediaAccessToken(kind, resourceKey);
    if (!token) return trimmed;
    parsed.searchParams.set(MEDIA_ACCESS_TOKEN_QUERY_KEY, token);
    return rebuildUrlLikeInput(trimmed, parsed);
  } catch {
    return trimmed;
  }
};

const toBool = (value: any, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(normalized)) return true;
    if (["0", "false", "no"].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeMediaPayload = (value: any): MediaItem[] => {
  if (value === undefined || value === null) return [];

  let source: any = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
  }

  const items = Array.isArray(source) ? source : [source];
  const normalized = items
    .map((entry: any) => {
      if (typeof entry === "string") {
        const url = removeMediaAccessTokenFromUrl(entry.trim());
        if (!url) return null;
        return { url, is_img: true };
      }

      if (!entry || typeof entry !== "object") return null;
      const url = removeMediaAccessTokenFromUrl(
        String(entry.url ?? entry.media_url ?? "").trim()
      );
      if (!url) return null;

      const type = String(entry.type ?? "").trim().toLowerCase();
      const inferredIsImg = type ? type !== "video" : true;
      const is_img = toBool(entry.is_img, inferredIsImg);

      return { url, is_img };
    })
    .filter((entry): entry is MediaItem => !!entry);

  const unique = new Map<string, MediaItem>();
  normalized.forEach((entry) => {
    unique.set(entry.url, entry);
  });

  return Array.from(unique.values());
};

const buildPostSessionMemoryKey = (
  viewerId: number | null,
  sessionTokenRaw: any
) => {
  const sessionToken = normalizeSessionToken(sessionTokenRaw);
  if (viewerId && sessionToken) return `u:${viewerId}:${sessionToken}`;
  if (viewerId) return `u:${viewerId}`;
  if (sessionToken) return `a:${sessionToken}`;
  return "";
};

const buildEmptyPostSessionState = (): PostSessionState => ({
  updatedAt: Date.now(),
  seenPostIds: [],
  recentCreatorIds: [],
  recentTopicIds: [],
  recentFormats: [],
  creatorImpressions: {},
  stableFeedIds: [],
});

const getPostSessionState = async (
  sessionMemoryKey: string
): Promise<{ state: PostSessionState; backend: "redis" | "memory" }> => {
  if (!sessionMemoryKey) {
    return { state: buildEmptyPostSessionState(), backend: "memory" };
  }

  const ttlSeconds = Math.max(60, Math.floor(POST_SESSION_TTL_MS / 1000));
  const loaded = await loadFindSessionState<PostSessionState>({
    scope: "post",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    initialState: buildEmptyPostSessionState(),
  });
  const state = loaded.state ?? buildEmptyPostSessionState();
  state.updatedAt = Date.now();
  return {
    state,
    backend: loaded.backend,
  };
};

const updatePostSessionState = async (
  sessionMemoryKey: string,
  sessionState: PostSessionState,
  selectedRows: any[]
) => {
  if (!sessionMemoryKey) return "memory" as const;
  const state = sessionState;

  if (Array.isArray(selectedRows) && selectedRows.length) {
    selectedRows.forEach((row) => {
      const postId = Number(row?.id);
      const creatorId = Number(row?.user?.id ?? row?.userId);
      const categoryId = Number(row?.categoryId);
      const format = detectPostFormatFromRichRow(row);

      if (Number.isFinite(postId) && postId > 0) {
        pushUniqueLimited(state.seenPostIds, postId, 500);
      }
      if (Number.isFinite(creatorId) && creatorId > 0) {
        pushUniqueLimited(state.recentCreatorIds, creatorId, 80);
        const key = String(creatorId);
        state.creatorImpressions[key] = Math.min(
          999,
          Number(state.creatorImpressions[key] ?? 0) + 1
        );
      }
      if (Number.isFinite(categoryId) && categoryId > 0) {
        pushUniqueLimited(state.recentTopicIds, categoryId, 120);
      }
      if (format) {
        pushUniqueLimited(state.recentFormats, format, 80);
      }
    });
  }

  if (Array.isArray(state.stableFeedIds)) {
    state.stableFeedIds = toUniqueNumbers(state.stableFeedIds).slice(
      0,
      POST_STABLE_FEED_MAX_IDS
    );
  } else {
    state.stableFeedIds = [];
  }

  const ttlSeconds = Math.max(60, Math.floor(POST_SESSION_TTL_MS / 1000));
  state.updatedAt = Date.now();
  return saveFindSessionState<PostSessionState>({
    scope: "post",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    state,
  });
};

const mergeStablePostFeedIds = (existingIdsRaw: any, rankedIdsRaw: any): number[] => {
  const existingIds = toUniqueNumbers(
    Array.isArray(existingIdsRaw) ? existingIdsRaw : []
  );
  const rankedIds = toUniqueNumbers(Array.isArray(rankedIdsRaw) ? rankedIdsRaw : []);

  const existingSet = new Set(existingIds);
  // Top-ranked posts not yet in the session (e.g. freshly published with newPostBoost) go first
  const hotNewIds = rankedIds.slice(0, 5).filter((id) => !existingSet.has(id));

  const merged: number[] = [];
  const seen = new Set<number>();

  const pushId = (id: number) => {
    if (!Number.isFinite(id) || id <= 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    merged.push(id);
  };

  for (const id of hotNewIds) {
    pushId(id);
    if (merged.length >= POST_STABLE_FEED_MAX_IDS) return merged;
  }
  for (const id of existingIds) {
    pushId(id);
    if (merged.length >= POST_STABLE_FEED_MAX_IDS) return merged;
  }
  for (const id of rankedIds) {
    pushId(id);
    if (merged.length >= POST_STABLE_FEED_MAX_IDS) return merged;
  }

  return merged;
};

const combineWhere = (baseWhere: any, extraWhere?: any) => {
  if (!extraWhere || !Object.keys(extraWhere).length) return baseWhere;
  return {
    [Op.and]: [baseWhere, extraWhere],
  };
};

const buildPostFeedWhere = (meId: any, suggested: boolean) => {
  const where: any = {
    is_delete: false,
    ...whereNotBlockedExists(meId, "`post`.`userId`"),
  };

  const viewerId = Number(meId);
  if (suggested && Number.isFinite(viewerId) && viewerId > 0) {
    where.userId = { [Op.ne]: viewerId };
  }

  return where;
};

const loadPostViewerContext = async (
  viewerId: number | null,
  profiler?: PostFindProfiler
): Promise<PostViewerContext> => {
  const context: PostViewerContext = {
    followedCreatorIds: new Set<number>(),
    interestCategoryIds: new Set<number>(),
    cityId: null,
    stateId: null,
    countryId: null,
    primaryLanguageCode: null,
    secondaryLanguageCodes: new Set<string>(),
  };
  if (!viewerId) return context;

  const [followRows, viewer] = await Promise.all([
    withPostDbProfile(profiler, "followers.findAll(viewer_follows)", () =>
      Follower.findAll({
        where: { followerId: viewerId },
        attributes: ["userId"],
        raw: true,
      })
    ),
    withPostDbProfile(profiler, "users.findByPk(viewer_context)", () =>
      User.findByPk(viewerId, {
        attributes: [
          "id",
          "job_category_ids",
          "language",
          "language_codes",
          "language_names",
          "city_residence_id",
          "state_residence_id",
          "country_residence_id",
          "cityId",
          "countryId",
        ],
      })
    ),
  ]);

  followRows.forEach((row: any) => {
    const creatorId = Number(row?.userId);
    if (Number.isFinite(creatorId) && creatorId > 0) {
      context.followedCreatorIds.add(creatorId);
    }
  });

  const categoryIds = toUniqueNumbers(parseJsonArray((viewer as any)?.job_category_ids));
  categoryIds.forEach((id) => context.interestCategoryIds.add(id));

  const cityId = Number((viewer as any)?.city_residence_id ?? (viewer as any)?.cityId);
  const stateId = Number((viewer as any)?.state_residence_id);
  const countryId = Number(
    (viewer as any)?.country_residence_id ?? (viewer as any)?.countryId
  );
  context.cityId = Number.isFinite(cityId) && cityId > 0 ? cityId : null;
  context.stateId = Number.isFinite(stateId) && stateId > 0 ? stateId : null;
  context.countryId = Number.isFinite(countryId) && countryId > 0 ? countryId : null;

  const languageCodes = toUniqueLanguageCodes([
    ...parseJsonArray((viewer as any)?.language_codes),
    ...parseJsonArray((viewer as any)?.language_names),
    (viewer as any)?.language,
  ]);
  if (languageCodes.length > 0) {
    context.primaryLanguageCode = languageCodes[0] ?? null;
    languageCodes.slice(1).forEach((code) => context.secondaryLanguageCodes.add(code));
  }

  return context;
};

const loadCreatorLocationMap = async (
  creatorIds: number[],
  profiler?: PostFindProfiler
) => {
  const ids = toUniqueNumbers(creatorIds);
  if (!ids.length) return new Map<number, any>();

  const rows = await withPostDbProfile(profiler, "users.findAll(creator_locations)", () =>
    User.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: [
        "id",
        "city_residence_id",
        "state_residence_id",
        "country_residence_id",
        "language",
        "language_codes",
        "language_names",
        "cityId",
        "countryId",
      ],
      raw: true,
    })
  );

  const map = new Map<number, any>();
  rows.forEach((row: any) => {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) return;
    const languageCodes = toUniqueLanguageCodes([
      ...parseJsonArray(row?.language_codes),
      ...parseJsonArray(row?.language_names),
      row?.language,
    ]);
    map.set(id, {
      cityId: Number(row?.city_residence_id ?? row?.cityId ?? 0) || null,
      stateId: Number(row?.state_residence_id ?? 0) || null,
      countryId: Number(row?.country_residence_id ?? row?.countryId ?? 0) || null,
      languageCodes,
      primaryLanguageCode: languageCodes[0] ?? null,
    });
  });
  return map;
};

const detectPostFormatFromCandidate = (row: any) => {
  const mediaCount = Number(row?.media_count ?? 0);
  const videoCount = Number(row?.video_count ?? 0);
  if (!Number.isFinite(mediaCount) || mediaCount <= 0) return "text";
  if (mediaCount > 1) {
    if (Number.isFinite(videoCount) && videoCount > 0) return "carrusel_video";
    return "carrusel";
  }
  if (Number.isFinite(videoCount) && videoCount > 0) return "video";
  return "image";
};

const detectPostFormatFromRichRow = (row: any) => {
  const media = Array.isArray((row as any)?.post_media) ? (row as any).post_media : [];
  if (!media.length) return "text";
  if (media.length > 1) {
    const hasVideo = media.some((item: any) => !Boolean(item?.is_img));
    return hasVideo ? "carrusel_video" : "carrusel";
  }
  return Boolean(media[0]?.is_img) ? "image" : "video";
};

const getPostQualityGateFailureReason = (row: any): string | null => {
  if (!row) return "null_row";
  const postId = Number(row?.id);
  const creatorId = Number(row?.userId);
  if (!Number.isFinite(postId) || postId <= 0) return "invalid_post_id";
  if (!Number.isFinite(creatorId) || creatorId <= 0) return "invalid_creator_id";
  if (Boolean(row?.is_delete)) return "post_deleted";

  const mediaCount = Number(row?.media_count ?? 0);
  const text = String(row?.post ?? "").trim();
  if ((!Number.isFinite(mediaCount) || mediaCount <= 0) && !text) return "empty_content";
  if (text.length > 0 && text.length < 2 && (!Number.isFinite(mediaCount) || mediaCount <= 0)) {
    return "text_too_short";
  }
  return null;
};

const postPassesQualityGate = (row: any) => {
  return getPostQualityGateFailureReason(row) === null;
};

const resolveLocationTier = (
  viewerContext: PostViewerContext,
  creatorLocation: any
): FeedLocationTier => {
  if (!creatorLocation) return "global";
  const sameCity =
    viewerContext.cityId &&
    creatorLocation.cityId &&
    Number(viewerContext.cityId) === Number(creatorLocation.cityId);
  if (sameCity) return "same_city";

  const sameState =
    viewerContext.stateId &&
    creatorLocation.stateId &&
    Number(viewerContext.stateId) === Number(creatorLocation.stateId);
  if (sameState) return "same_state";

  const sameCountry =
    viewerContext.countryId &&
    creatorLocation.countryId &&
    Number(viewerContext.countryId) === Number(creatorLocation.countryId);
  if (sameCountry) return "same_country";

  return "global";
};

const toLocalScoreByTier = (tier: FeedLocationTier): number => {
  if (tier === "same_city") return 1;
  if (tier === "same_state") return 0.75;
  if (tier === "same_country") return 0.45;
  return 0;
};

const toContentKindByFormat = (format: string): FeedContentKind => {
  const normalized = String(format ?? "").trim().toLowerCase();
  if (normalized === "video" || normalized === "carrusel_video") return "video";
  if (normalized === "image" || normalized === "carrusel") return "image";
  if (normalized === "text") return "text";
  return "other";
};

const resolveLanguageTier = (
  viewerContext: PostViewerContext,
  creatorProfile: any
): FeedLanguageTier => {
  const creatorCodes = toUniqueLanguageCodes([
    ...(Array.isArray(creatorProfile?.languageCodes) ? creatorProfile.languageCodes : []),
    creatorProfile?.primaryLanguageCode,
  ]);
  if (!creatorCodes.length) return "unknown";

  const viewerPrimary = normalizeLanguageCode(viewerContext.primaryLanguageCode);
  if (viewerPrimary && creatorCodes.includes(viewerPrimary)) return "primary";

  const viewerSecondary = new Set(
    toUniqueLanguageCodes(Array.from(viewerContext.secondaryLanguageCodes.values()))
  );
  if (
    viewerSecondary.size > 0 &&
    creatorCodes.some((code) => viewerSecondary.has(code))
  ) {
    return "secondary";
  }

  return "other";
};

const fetchPostCandidatePool = async ({
  where,
  replacements,
  viewerContext,
  viewerId,
  size,
  page,
  summary = false,
  profiler,
}: {
  where: any;
  replacements: Record<string, any>;
  viewerContext: PostViewerContext;
  viewerId: number | null;
  size: number;
  page: number;
  summary?: boolean;
  profiler?: PostFindProfiler;
}) => {
  const pageFactor = Math.max(1, page + 1);
  const basePoolSize = summary
    ? Math.min(240, Math.max(80, size * 8, pageFactor * size * 5))
    : Math.min(300, Math.max(100, size * 10, pageFactor * size * 6));
  const trendingPoolSize = Math.max(size * 3, Math.floor(basePoolSize * 0.5));
  const socialPoolSize = Math.max(size * 2, Math.floor(basePoolSize * 0.35));
  const explorationPoolSize = Math.max(size * 2, Math.floor(basePoolSize * 0.3));

  const followedIds = Array.from(viewerContext.followedCreatorIds.values());
  const excludedCreatorIds = toUniqueNumbers([...followedIds, viewerId ?? 0]);
  const categoryIds = Array.from(viewerContext.interestCategoryIds.values());
  const includeCommentSignals = !summary;

  const attributes: any[] = [
    "id",
    "userId",
    "categoryId",
    "created_date",
    "likes_count",
    "saves_count",
    "shares_count",
    "post",
    ...(includeCommentSignals ? ([[candidateCommentCountAttribute, "comments_count"]] as any[]) : []),
    [candidateMediaCountAttribute, "media_count"],
    [candidateVideoCountAttribute, "video_count"],
  ];

  const readRows = async (params: {
    label: string;
    extraWhere?: any;
    order: any[];
    limit: number;
    indexHintValues?: string[];
  }) => {
    const indexHints =
      Array.isArray(params.indexHintValues) && params.indexHintValues.length > 0
        ? [
            {
              type: IndexHints.USE,
              values: params.indexHintValues,
            },
          ]
        : undefined;

    return withPostDbProfile(profiler, params.label, () =>
      Post.findAll({
        where: combineWhere(where, params.extraWhere),
        replacements,
        attributes,
        indexHints: indexHints as any,
        order: params.order,
        limit: Math.max(1, Math.floor(params.limit)),
        raw: true,
      })
    );
  };

  const [recentRows, trendingRows, socialRows, interestRows, explorationRows] =
    await Promise.all([
      readRows({
        label: "posts.findAll(candidate_recent)",
        indexHintValues: ["idx_posts_feed_recent_visible"],
        order: [["created_date", "DESC"], ["id", "DESC"]],
        limit: basePoolSize,
      }),
      readRows({
        label: "posts.findAll(candidate_trending)",
        indexHintValues: ["idx_posts_feed_trending_visible"],
        order: [
          ["shares_count", "DESC"],
          ["saves_count", "DESC"],
          ["likes_count", "DESC"],
          ...(includeCommentSignals
            ? ([[Sequelize.literal("comments_count"), "DESC"]] as any[])
            : []),
          ["created_date", "DESC"],
          ["id", "DESC"],
        ],
        limit: trendingPoolSize,
      }),
      followedIds.length
        ? readRows({
            label: "posts.findAll(candidate_social)",
            indexHintValues: ["idx_posts_feed_user_visible_recent"],
            extraWhere: { userId: { [Op.in]: followedIds } },
            order: [["created_date", "DESC"], ["id", "DESC"]],
            limit: socialPoolSize,
          })
        : Promise.resolve([] as any[]),
      categoryIds.length
        ? readRows({
            label: "posts.findAll(candidate_interest)",
            indexHintValues: ["idx_posts_feed_category_visible_recent"],
            extraWhere: { categoryId: { [Op.in]: categoryIds } },
            order: [["created_date", "DESC"], ["id", "DESC"]],
            limit: socialPoolSize,
          })
        : Promise.resolve([] as any[]),
      readRows({
        label: "posts.findAll(candidate_exploration)",
        indexHintValues: ["idx_posts_feed_recent_visible"],
        extraWhere: excludedCreatorIds.length
          ? { userId: { [Op.notIn]: excludedCreatorIds } }
          : undefined,
        order: [["created_date", "DESC"], ["id", "DESC"]],
        limit: explorationPoolSize,
      }),
    ]);

  const unique = new Map<number, any>();
  [...socialRows, ...interestRows, ...recentRows, ...trendingRows, ...explorationRows].forEach(
    (row: any) => {
      const id = Number(row?.id);
      if (!Number.isFinite(id) || id <= 0) return;
      if (!unique.has(id)) unique.set(id, row);
    }
  );

  return Array.from(unique.values());
};

const buildPostCandidate = ({
  row,
  viewerContext,
  viewerId,
  sessionState,
  creatorLocationMap,
}: {
  row: any;
  viewerContext: PostViewerContext;
  viewerId: number | null;
  sessionState: PostSessionState;
  creatorLocationMap: Map<number, any>;
}): PostCandidate | null => {
  if (!postPassesQualityGate(row)) return null;

  const id = Number(row?.id);
  const creatorId = Number(row?.userId);
  const categoryId = Number(row?.categoryId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(creatorId) || creatorId <= 0) {
    return null;
  }

  const createdDateRaw = row?.created_date ?? row?.createdAt;
  const createdDate = createdDateRaw ? new Date(createdDateRaw) : null;
  const ageHours =
    createdDate && !Number.isNaN(createdDate.getTime())
      ? Math.max(0, (Date.now() - createdDate.getTime()) / (60 * 60 * 1000))
      : 96;

  const likes = Number(row?.likes_count ?? 0) || 0;
  const saves = Number(row?.saves_count ?? 0) || 0;
  const shares = Number(row?.shares_count ?? 0) || 0;
  const comments = Number(row?.comments_count ?? 0) || 0;
  const mediaCount = Number(row?.media_count ?? 0) || 0;
  const textLength = String(row?.post ?? "").trim().length;
  const format = detectPostFormatFromCandidate(row);

  const affinityScore =
    Number.isFinite(categoryId) &&
    categoryId > 0 &&
    viewerContext.interestCategoryIds.has(categoryId)
      ? 1
      : 0;
  const dwellProxyScore = clamp01(
    Math.log1p(likes + saves * 3 + shares * 4 + comments * 2 + mediaCount) / 8
  );
  const freshnessScore = clamp01(Math.exp(-ageHours / 48));
  const socialScore = viewerContext.followedCreatorIds.has(creatorId) ? 1 : 0;
  const qualityScore = clamp01(
    (Math.log1p(likes + comments * 2 + shares * 3 + saves * 2 + 1) / 8) *
      (textLength >= 4 || mediaCount > 0 ? 1 : 0.7)
  );

  const creatorExposure = Number(sessionState.creatorImpressions[String(creatorId)] ?? 0);
  const noveltyScore =
    creatorExposure <= 0 ? 1 : creatorExposure === 1 ? 0.65 : creatorExposure === 2 ? 0.4 : 0.15;
  const explorationScore = socialScore > 0 ? 0 : clamp01(noveltyScore * 0.75 + 0.25);
  const trendingScore = clamp01(
    (Math.log1p(likes + comments * 2 + shares * 3 + saves * 3) / 9) *
      (0.65 + 0.35 * freshnessScore)
  );
  const creatorProfile = creatorLocationMap.get(creatorId);
  const locationTier = resolveLocationTier(viewerContext, creatorProfile);
  const languageTier = resolveLanguageTier(viewerContext, creatorProfile);
  const contentKind = toContentKindByFormat(format);
  const relevanceScore = calculateFeedScore({
    locationTier,
    languageTier,
    contentKind,
    ageHours,
    recencyHalfLifeHours: 24,
    recencyMaxPoints: 40,
    ownPostBoostWindowMinutes: 30,
    ownPostBoostPoints: 60,
    ownPostBoostApplied:
      Boolean(viewerId) && Number.isFinite(creatorId) && Number(creatorId) === Number(viewerId) && ageHours <= 0.5,
  });
  const localScore = toLocalScoreByTier(locationTier);

  const newPostBoost = relevanceScore.breakdown.ownPostBoost;

  const seenInSession = sessionState.seenPostIds.includes(id);
  const repetitionPenalty = sessionState.recentCreatorIds.includes(creatorId) ? 0.2 : 0;
  const topicPenalty =
    Number.isFinite(categoryId) && categoryId > 0 && sessionState.recentTopicIds.includes(categoryId)
      ? 0.08
      : 0;
  const formatPenalty = sessionState.recentFormats.includes(format) ? 0.06 : 0;
  const fatiguePenalty = seenInSession ? 0.55 : 0;
  const lowQualityPenalty =
    ageHours > 96 && likes + comments + shares + saves < 4 && dwellProxyScore < 0.2 ? 0.18 : 0;

  const weightedBase =
    0.3 * affinityScore +
    0.2 * dwellProxyScore +
    0.2 * freshnessScore +
    0.15 * socialScore +
    0.1 * qualityScore +
    0.05 * explorationScore;

  const behavioralScore =
    22 * weightedBase +
    8 * noveltyScore +
    7 * trendingScore -
    14 * repetitionPenalty -
    12 * topicPenalty -
    10 * formatPenalty -
    40 * fatiguePenalty -
    24 * lowQualityPenalty;
  const finalScore = relevanceScore.totalScore + behavioralScore;

  let bucket: PostBucket = "exploration";
  if (socialScore > 0) bucket = "social";
  else if (affinityScore > 0) bucket = "interest";
  else if (localScore >= 0.75) bucket = "local";
  else if (trendingScore >= 0.45) bucket = "trending";

  return {
    row,
    id,
    creatorId,
    categoryId: Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0,
    format,
    bucket,
    localScore,
    feedScore: relevanceScore.totalScore,
    seenInSession,
    qualityPassed: true,
    finalScore: round3(finalScore),
    rankingReason: relevanceScore.rankingReason,
    scoreBreakdown: {
      affinity: affinityScore,
      dwellProxy: dwellProxyScore,
      freshness: freshnessScore,
      social: socialScore,
      quality: qualityScore,
      exploration: explorationScore,
      novelty: noveltyScore,
      trending: trendingScore,
      local: localScore,
      weightedBase,
      newPostBoost,
      relevanceBase: relevanceScore.totalScore,
      behavioralScore,
      locationPoints: relevanceScore.breakdown.locationScore,
      languagePoints: relevanceScore.breakdown.languageScore,
      contentTypePoints: relevanceScore.breakdown.contentTypeScore,
      recencyPoints: relevanceScore.breakdown.recencyScore,
      ownPostBoostPoints: relevanceScore.breakdown.ownPostBoost,
      creatorPenalty: repetitionPenalty,
      topicPenalty,
      formatPenalty,
      fatiguePenalty,
      lowQualityPenalty,
    },
  };
};

const POST_BUCKETS: PostBucket[] = [
  "interest",
  "social",
  "trending",
  "local",
  "exploration",
];

const buildPostBucketTargets = ({
  desiredCount,
  availableByBucket,
  hasViewer,
}: {
  desiredCount: number;
  availableByBucket: Record<PostBucket, number>;
  hasViewer: boolean;
}) => {
  const weights: Record<PostBucket, number> = {
    interest: 0.35,
    social: 0.25,
    trending: 0.2,
    local: 0.1,
    exploration: 0.1,
  };

  if (!hasViewer) {
    weights.interest = 0.25;
    weights.social = 0;
    weights.trending = 0.45;
    weights.local = 0;
    weights.exploration = 0.3;
  }

  if (!availableByBucket.social) {
    weights.trending += weights.social * 0.6;
    weights.exploration += weights.social * 0.4;
    weights.social = 0;
  }
  if (!availableByBucket.local) {
    weights.trending += weights.local * 0.5;
    weights.exploration += weights.local * 0.5;
    weights.local = 0;
  }
  if (!availableByBucket.interest) {
    weights.trending += weights.interest * 0.6;
    weights.exploration += weights.interest * 0.4;
    weights.interest = 0;
  }

  const active = POST_BUCKETS.filter(
    (bucket) => availableByBucket[bucket] > 0 && weights[bucket] > 0
  );
  const targets: Record<PostBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };
  if (!active.length) return targets;

  const weightSum = active.reduce((sum, bucket) => sum + weights[bucket], 0);
  let assigned = 0;
  active.forEach((bucket, index) => {
    const available = availableByBucket[bucket];
    if (index === active.length - 1) {
      const remaining = Math.max(0, desiredCount - assigned);
      targets[bucket] = Math.min(available, remaining);
      assigned += targets[bucket];
      return;
    }
    const rawTarget = Math.floor((desiredCount * weights[bucket]) / weightSum);
    const safeTarget = Math.max(0, Math.min(available, rawTarget));
    targets[bucket] = safeTarget;
    assigned += safeTarget;
  });

  while (assigned < desiredCount) {
    let grew = false;
    for (const bucket of active) {
      if (targets[bucket] < availableByBucket[bucket]) {
        targets[bucket] += 1;
        assigned += 1;
        grew = true;
      }
      if (assigned >= desiredCount) break;
    }
    if (!grew) break;
  }

  return targets;
};

const selectPostCandidates = ({
  scoredCandidates,
  desiredCount,
  bucketTargets,
}: {
  scoredCandidates: PostCandidate[];
  desiredCount: number;
  bucketTargets: Record<PostBucket, number>;
}) => {
  const selected: PostCandidate[] = [];
  const selectedIds = new Set<number>();
  const recentCreatorWindow: number[] = [];
  const bucketCounts: Record<PostBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };

  let currentTopic = 0;
  let topicStreak = 0;
  let currentFormat = "";
  let formatStreak = 0;

  const hasUnfilledTarget = () =>
    POST_BUCKETS.some((bucket) => bucketCounts[bucket] < (bucketTargets[bucket] ?? 0));

  const registerSelection = (candidate: PostCandidate) => {
    selected.push(candidate);
    selectedIds.add(candidate.id);
    bucketCounts[candidate.bucket] += 1;
    pushUniqueLimited(recentCreatorWindow, candidate.creatorId, POST_CREATOR_COOLDOWN);

    if (candidate.categoryId > 0 && candidate.categoryId === currentTopic) {
      topicStreak += 1;
    } else {
      currentTopic = candidate.categoryId;
      topicStreak = candidate.categoryId > 0 ? 1 : 0;
    }

    if (candidate.format && candidate.format === currentFormat) {
      formatStreak += 1;
    } else {
      currentFormat = candidate.format;
      formatStreak = candidate.format ? 1 : 0;
    }
  };

  const canSelect = (candidate: PostCandidate, phase: number): string | null => {
    if (selectedIds.has(candidate.id)) return "already_selected";
    if (!candidate.qualityPassed) return "quality_gate_failed";

    const strictBuckets = phase === 0;
    const strictDiversity = phase <= 1;
    const strictFatigue = phase <= 1;

    if (strictFatigue && candidate.seenInSession) return "seen_in_session";
    if (phase === 0 && candidate.finalScore < -0.05) return "low_score_floor";

    if (strictDiversity && recentCreatorWindow.includes(candidate.creatorId)) {
      return "creator_cooldown";
    }
    if (
      strictDiversity &&
      candidate.categoryId > 0 &&
      topicStreak >= POST_MAX_TOPIC_STREAK &&
      currentTopic > 0 &&
      candidate.categoryId === currentTopic
    ) {
      return "topic_streak_limit";
    }
    if (
      strictDiversity &&
      candidate.format &&
      formatStreak >= POST_MAX_FORMAT_STREAK &&
      currentFormat &&
      candidate.format === currentFormat
    ) {
      return "format_streak_limit";
    }

    if (strictBuckets) {
      const bucketTarget = bucketTargets[candidate.bucket] ?? 0;
      const bucketCount = bucketCounts[candidate.bucket] ?? 0;
      if (bucketTarget > 0 && bucketCount >= bucketTarget && hasUnfilledTarget()) {
        return "bucket_target_filled";
      }
    }

    return null;
  };

  for (let phase = 0; phase < 3 && selected.length < desiredCount; phase += 1) {
    for (const candidate of scoredCandidates) {
      if (selected.length >= desiredCount) break;
      const reason = canSelect(candidate, phase);
      if (reason) {
        if (!candidate.excludedReason || phase === 0) {
          candidate.excludedReason = reason;
        }
        continue;
      }
      registerSelection(candidate);
    }
  }

  if (selected.length < desiredCount) {
    for (const candidate of scoredCandidates) {
      if (selected.length >= desiredCount) break;
      if (selectedIds.has(candidate.id)) continue;
      if (!candidate.qualityPassed) continue;
      registerSelection(candidate);
    }
  }

  scoredCandidates.forEach((candidate) => {
    if (selectedIds.has(candidate.id)) return;
    if (!candidate.excludedReason) {
      candidate.excludedReason = "not_selected_after_rerank";
    }
  });

  return selected;
};

const applyPostTopKShuffle = (candidates: PostCandidate[], seedRaw: any) => {
  if (!Array.isArray(candidates) || candidates.length <= 2) return candidates;
  const seed = normalizeSessionToken(seedRaw) || "post-feed";
  const windowSize = Math.min(POST_TOPK_SHUFFLE_WINDOW, candidates.length);

  const head = candidates
    .slice(0, windowSize)
    .map((candidate) => {
      const hash = hashString(`${seed}:${candidate.id}`);
      const noise = (hash % 1000) / 1000 - 0.5;
      return {
        candidate,
        rank: candidate.finalScore + noise * 0.03,
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.candidate);

  return [...head, ...candidates.slice(windowSize)];
};

const logPostFindDebug = ({
  viewerId,
  page,
  size,
  totalCount,
  candidatePoolSize,
  qualityRejected,
  bucketTargets,
  scoredCandidates,
  selectedCandidates,
  pageCandidates,
}: {
  viewerId: number | null;
  page: number;
  size: number;
  totalCount: number;
  candidatePoolSize: number;
  qualityRejected: Array<{ id: number; creatorId: number; reason: string }>;
  bucketTargets: Record<PostBucket, number>;
  scoredCandidates: PostCandidate[];
  selectedCandidates: PostCandidate[];
  pageCandidates: PostCandidate[];
}) => {
  if (!shouldLogFindDebug()) return;

  const maxItems = getFindDebugMaxItems();
  const selectedIds = new Set<number>(selectedCandidates.map((candidate) => candidate.id));
  const pageIds = new Set<number>(pageCandidates.map((candidate) => candidate.id));

  console.log(
    `[find/post] summary ${JSON.stringify({
      viewerId: viewerId ?? null,
      page,
      size,
      totalCount,
      candidatePoolSize,
      qualityRejected: qualityRejected.length,
      scoredCandidates: scoredCandidates.length,
      selected: selectedCandidates.length,
      served: pageCandidates.length,
      bucketTargets,
    })}`
  );

  qualityRejected.slice(0, maxItems).forEach((item) => {
    console.log(
      `[find/post/item] ${JSON.stringify({
        post_id: item.id,
        creator_id: item.creatorId,
        bucket: "quality_gate",
        score_final: null,
        penalties_applied: null,
        excluded_reason: item.reason,
      })}`
    );
  });

  scoredCandidates.slice(0, maxItems).forEach((candidate, index) => {
    const state = pageIds.has(candidate.id)
      ? "served"
      : selectedIds.has(candidate.id)
      ? "selected_prior_page"
      : "filtered_out";

    const excludedReason =
      state === "filtered_out"
        ? candidate.excludedReason ?? "below_cutline"
        : state === "selected_prior_page"
        ? "selected_but_not_in_current_page_window"
        : null;

    console.log(
      `[find/post/item] ${JSON.stringify({
        rank: index + 1,
        post_id: candidate.id,
        creator_id: candidate.creatorId,
        bucket: candidate.bucket,
        format: candidate.format,
        state,
        score_final: round3(candidate.finalScore),
        penalties_applied: {
          creator: round3(candidate.scoreBreakdown.creatorPenalty),
          topic: round3(candidate.scoreBreakdown.topicPenalty),
          format: round3(candidate.scoreBreakdown.formatPenalty),
          fatigue: round3(candidate.scoreBreakdown.fatiguePenalty),
          low_quality: round3(candidate.scoreBreakdown.lowQualityPenalty),
        },
        excluded_reason: excludedReason,
      })}`
    );
  });
};

const logPostFindPerf = ({
  viewerId,
  page,
  size,
  totalCount,
  candidatePoolSize,
  profiler,
}: {
  viewerId: number | null;
  page: number;
  size: number;
  totalCount: number;
  candidatePoolSize: number;
  profiler: PostFindProfiler;
}) => {
  if (!shouldLogFindProfile()) return;
  const totalMs = nowMs() - profiler.startedAtMs;
  const topQueries = [...profiler.dbQueries]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((query) => ({
      label: query.label,
      ms: round3(query.ms),
    }));

  console.log(
    `[find/post/perf] ${JSON.stringify({
      viewerId: viewerId ?? null,
      page,
      size,
      totalCount,
      candidatePoolSize,
      totalLatencyMs: round3(totalMs),
      rerankMs: round3(profiler.rerankMs),
      sessionLoadMs: round3(profiler.sessionLoadMs),
      sessionSaveMs: round3(profiler.sessionSaveMs),
      sessionOverheadMs: round3(profiler.sessionLoadMs + profiler.sessionSaveMs),
      sessionLoadBackend: profiler.sessionLoadBackend,
      sessionSaveBackend: profiler.sessionSaveBackend,
      dbQueryCount: profiler.dbQueries.length,
      topQueries,
    })}`
  );
};

const fetchPostsByIdsOrdered = async (
  postIds: number[],
  meId: any,
  includeCommentCount: boolean,
  profiler?: PostFindProfiler
) => {
  const ids = toUniqueNumbers(postIds);
  if (!ids.length) return [];

  const posts = await withPostDbProfile(profiler, "posts.findAll(hydrate_selected_base)", () =>
    Post.findAll({
      where: {
        id: { [Op.in]: ids },
        is_delete: false,
        ...whereNotBlockedExists(meId, "`post`.`userId`"),
      },
      replacements: { meId },
      attributes: includeCommentCount
        ? {
            exclude: excludeKeys,
            include: [commentCountAttribute],
          }
        : { exclude: excludeKeys },
    })
  );

  if (!posts.length) return [];

  await applyPostHashtags(posts);

  const userIds = toUniqueNumbers(posts.map((post: any) => Number(post?.userId)));
  const postIdSet = new Set<number>(posts.map((post: any) => Number(post?.id)).filter((id) => id > 0));
  const selectedPostIds = Array.from(postIdSet.values());

  const [users, mediaRows, likeRows, commentRows] = await Promise.all([
    userIds.length
      ? withPostDbProfile(profiler, "users.findAll(hydrate_users)", () =>
          User.findAll({
            where: { id: { [Op.in]: userIds } },
            attributes: [
              "id",
              "name",
              "last_name",
              "username",
              "email",
              "image_profil",
              "verified",
              "profile_verified",
              "profile_verification_status",
              "available",
            ],
          })
        )
      : Promise.resolve([] as any[]),
    withPostDbProfile(profiler, "mediapost.findAll(hydrate_media)", () =>
      MediaPost.findAll({
        where: { postId: { [Op.in]: selectedPostIds } },
        attributes: ["postId", "url", "is_img"],
        order: [
          ["postId", "ASC"],
          ["createdAt", "ASC"],
        ],
      })
    ),
    withPostDbProfile(profiler, "likes.findAll(hydrate_likes)", () =>
      Like.findAll({
        where: { postId: { [Op.in]: selectedPostIds } },
        attributes: ["id", "userId", "postId"],
      })
    ),
    withPostDbProfile(profiler, "comments.findAll(hydrate_comments)", () =>
      Comment.findAll({
        where: {
          postId: { [Op.in]: selectedPostIds },
          is_delete: false,
        },
        attributes: ["id", "userId", "postId", "comment", "media_url", "created_date"],
        include: [
          {
            model: User,
            as: "commentator",
            attributes: [
              "id",
              "name",
              "last_name",
              "username",
              "image_profil",
              "profile_verified",
              "profile_verification_status",
            ],
            required: false,
          },
        ],
        order: [
          ["postId", "ASC"],
          ["created_date", "DESC"],
        ],
      })
    ),
  ]);

  await Promise.all([applyPostHashtags(posts), applyCommentHashtags(commentRows as any[])]);
  const viewerId = Number(meId);
  const validViewerId = Number.isFinite(viewerId) && viewerId > 0 ? viewerId : null;

  const userById = new Map<number, any>();
  users.forEach((user: any) => {
    const id = Number(user?.id);
    if (Number.isFinite(id) && id > 0) {
      userById.set(id, toPlain(user));
    }
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: Array.from(userById.values()),
    viewerIdRaw: meId,
  });

  const mediaByPostId = new Map<number, any[]>();
  mediaRows.forEach((media: any) => {
    const postId = Number(media?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
    const list = mediaByPostId.get(postId) ?? [];
    list.push({
      url: refreshSignedMediaUrl(String(media?.url ?? "")),
      is_img: Boolean(media?.is_img),
    });
    mediaByPostId.set(postId, list);
  });

  const likesByPostId = new Map<number, any[]>();
  const likedPostIds = new Set<number>();
  likeRows.forEach((like: any) => {
    const postId = Number(like?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
    const likeUserId = Number(like?.userId);
    if (validViewerId && likeUserId === validViewerId) {
      likedPostIds.add(postId);
    }
    const list = likesByPostId.get(postId) ?? [];
    list.push({
      id: Number(like?.id),
      userId: Number(like?.userId),
    });
    likesByPostId.set(postId, list);
  });

  const commentsByPostId = new Map<number, any[]>();
  commentRows.forEach((comment: any) => {
    const postId = Number((comment as any)?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
    const list = commentsByPostId.get(postId) ?? [];
    const plainComment = toPlain(comment);
    list.push({
      id: Number(plainComment?.id),
      userId: Number(plainComment?.userId),
      comment: plainComment?.comment ?? null,
      media_url: plainComment?.media_url
        ? refreshSignedMediaUrl(String(plainComment.media_url))
        : null,
      created_date: plainComment?.created_date ?? null,
      commentator: plainComment?.commentator ?? null,
    });
    commentsByPostId.set(postId, list);
  });

  const byId = new Map<number, any>();
  posts.forEach((post: any) => {
    const postId = Number(post?.id);
    if (!Number.isFinite(postId) || postId <= 0) return;
    const userId = Number(post?.userId);
    const rawUser = userById.get(userId) ?? null;
    if (!rawUser) return;
    const user = rawUser
      ? {
          ...rawUser,
          roles: Array.isArray(rawUser?.roles) ? rawUser.roles : [],
          worker: rawUser?.worker ?? null,
          categories: Array.isArray(rawUser?.categories) ? rawUser.categories : [],
          followers: Array.isArray(rawUser?.followers) ? rawUser.followers : [],
          followings: Array.isArray(rawUser?.followings) ? rawUser.followings : [],
        }
      : null;
    const postMedia = mediaByPostId.get(postId) ?? [];
    const postLikes = likesByPostId.get(postId) ?? [];
    const postComments = commentsByPostId.get(postId) ?? [];

    post.setDataValue("user", user);
    post.setDataValue("post_media", postMedia);
    post.setDataValue("likes", postLikes);
    post.setDataValue("comments", postComments);
    const likedByViewer = likedPostIds.has(postId);
    post.setDataValue("is_liked", likedByViewer);
    post.setDataValue("isLiked", likedByViewer);
    post.setDataValue("isLike", likedByViewer);
    post.setDataValue("is_like", likedByViewer);
    post.setDataValue("liked", likedByViewer);
    post.setDataValue("is_starred", likedByViewer);
    post.setDataValue("isStarred", likedByViewer);
    post.setDataValue("starred", likedByViewer);
    byId.set(postId, post);
  });

  return postIds.map((id) => byId.get(Number(id))).filter(Boolean);
};

const fetchPostsByIdsOrderedSummary = async (
  postIds: number[],
  meId: any,
  profiler?: PostFindProfiler
) => {
  const ids = toUniqueNumbers(postIds);
  if (!ids.length) return [];

  const posts = await withPostDbProfile(profiler, "posts.findAll(hydrate_selected_summary)", () =>
    Post.findAll({
      where: {
        id: { [Op.in]: ids },
        is_delete: false,
        ...whereNotBlockedExists(meId, "`post`.`userId`"),
      },
      replacements: { meId },
      attributes: [
        "id",
        "userId",
        "post",
        "created_date",
        "likes_count",
        "saves_count",
        "shares_count",
      ],
    })
  );

  if (!posts.length) return [];

  const userIds = toUniqueNumbers(posts.map((post: any) => Number(post?.userId)));
  const viewerId = Number(meId);
  const validViewerId = Number.isFinite(viewerId) && viewerId > 0 ? viewerId : null;

  const [users, mediaRows, viewerLikes, summaryCommentCountRows] = await Promise.all([
    userIds.length
      ? withPostDbProfile(profiler, "users.findAll(hydrate_users_summary)", () =>
          User.findAll({
            where: { id: { [Op.in]: userIds } },
            attributes: [
              "id",
              "name",
              "last_name",
              "username",
              "image_profil",
              "verified",
              "profile_verified",
              "profile_verification_status",
            ],
          })
        )
      : Promise.resolve([] as any[]),
    withPostDbProfile(profiler, "mediapost.findAll(hydrate_media_summary)", () =>
      MediaPost.findAll({
        where: { postId: { [Op.in]: ids } },
        attributes: ["postId", "url", "is_img"],
        order: [
          ["postId", "ASC"],
          ["createdAt", "ASC"],
        ],
      })
    ),
    validViewerId
      ? withPostDbProfile(profiler, "likes.findAll(hydrate_viewer_likes_summary)", () =>
          Like.findAll({
            where: { postId: { [Op.in]: ids }, userId: validViewerId },
            attributes: ["postId", "userId"],
          })
        )
      : Promise.resolve([] as any[]),
    withPostDbProfile(profiler, "comments.findAll(hydrate_comment_counts_summary)", () =>
      Comment.findAll({
        where: { postId: { [Op.in]: ids }, is_delete: false },
        attributes: [
          "postId",
          [Sequelize.fn("COUNT", Sequelize.col("id")), "comments_count"],
        ],
        group: ["postId"],
        raw: true,
      })
    ),
  ]);

  const userById = new Map<number, any>();
  users.forEach((user: any) => {
    const id = Number(user?.id);
    if (Number.isFinite(id) && id > 0) userById.set(id, toPlain(user));
  });

  const mediaByPostId = new Map<number, any>();
  mediaRows.forEach((media: any) => {
    const postId = Number(media?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
    if (mediaByPostId.has(postId)) return;
    mediaByPostId.set(postId, {
      url: refreshSignedMediaUrl(String(media?.url ?? "")),
      is_img: Boolean(media?.is_img),
    });
  });

  const likedPostIds = new Set<number>();
  viewerLikes.forEach((like: any) => {
    const postId = Number(like?.postId);
    if (Number.isFinite(postId) && postId > 0) likedPostIds.add(postId);
  });

  const commentCountByPostId = new Map<number, number>();
  (Array.isArray(summaryCommentCountRows) ? summaryCommentCountRows : []).forEach((row: any) => {
    const postId = Number(row?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
    commentCountByPostId.set(postId, Number(row?.comments_count ?? 0) || 0);
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: Array.from(userById.values()),
    viewerIdRaw: meId,
  });

  const byId = new Map<number, any>();
  posts.forEach((post: any) => {
    const postId = Number(post?.id);
    const userId = Number(post?.userId);
    const user = userById.get(userId) ?? null;
    if (!user) return;
    post.setDataValue("user", user);
    post.setDataValue("post_media", mediaByPostId.has(postId) ? [mediaByPostId.get(postId)] : []);
    post.setDataValue("likes", []);
    post.setDataValue("comments", []);
    const likedByViewer = likedPostIds.has(postId);
    post.setDataValue("is_liked", likedByViewer);
    post.setDataValue("isLiked", likedByViewer);
    post.setDataValue("isLike", likedByViewer);
    post.setDataValue("is_like", likedByViewer);
    post.setDataValue("liked", likedByViewer);
    post.setDataValue("is_starred", likedByViewer);
    post.setDataValue("isStarred", likedByViewer);
    post.setDataValue("starred", likedByViewer);
    post.setDataValue("comments_count", commentCountByPostId.get(postId) ?? 0);
    byId.set(postId, post);
  });

  return ids.map((id) => byId.get(Number(id))).filter(Boolean);
};

const runPostFindRanking = async ({
  pageRaw,
  sizeRaw,
  meId,
  suggested,
  options,
  summary = false,
}: {
  pageRaw: any;
  sizeRaw: any;
  meId: any;
  suggested: boolean;
  options?: PostFeedOptions;
  summary?: boolean;
}) => {
  const profiler = createPostFindProfiler();
  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 10, 40);
  const viewerId = Number(meId);
  const validViewerId = Number.isFinite(viewerId) && viewerId > 0 ? viewerId : null;
  const includeRankingDebug = Boolean(options?.includeRankingDebug);
  const useSessionState = !summary || POST_SUMMARY_SESSION_STATE_ENABLED;
  const sessionToken = useSessionState ? normalizeSessionToken(options?.sessionKey) : "";
  const sessionMemoryKeyBase = useSessionState
    ? buildPostSessionMemoryKey(validViewerId, sessionToken)
    : "";
  const sessionVariant = suggested ? "suggested" : "feed";
  const sessionMemoryKey = sessionMemoryKeyBase
    ? `${sessionMemoryKeyBase}:${sessionVariant}`
    : "";
  let sessionState = buildEmptyPostSessionState();
  let sessionLoadBackend: "redis" | "memory" = "memory";
  if (useSessionState) {
    const sessionLoadStartedAtMs = nowMs();
    const loaded = await getPostSessionState(sessionMemoryKey);
    sessionState = loaded.state;
    sessionLoadBackend = loaded.backend;
    profiler.sessionLoadMs = nowMs() - sessionLoadStartedAtMs;
  }
  profiler.sessionLoadBackend = sessionLoadBackend;
  const start = page * size;
  const end = start + size;
  const desiredCount = Math.max(end, size);

  const where = buildPostFeedWhere(meId, suggested);
  const replacements = { meId };
  const totalCountCacheKey = summary
    ? `s:${suggested ? 1 : 0}:v:${validViewerId ?? 0}`
    : "";
  const cachedTotalCount = totalCountCacheKey
    ? readCachedPostFeedTotalCount(totalCountCacheKey)
    : null;
  const cachedViewerContext = summary ? readCachedPostViewerContext(validViewerId) : null;

  const [totalCount, viewerContext] = await Promise.all([
    cachedTotalCount !== null
      ? Promise.resolve(cachedTotalCount)
      : withPostDbProfile(profiler, "posts.count(feed_total)", () =>
          Post.count({
            where,
            replacements,
            distinct: true,
            col: "id",
          } as any)
        ),
    cachedViewerContext
      ? Promise.resolve(cachedViewerContext)
      : loadPostViewerContext(validViewerId, profiler),
  ]);
  if (cachedTotalCount === null && totalCountCacheKey) {
    writeCachedPostFeedTotalCount(totalCountCacheKey, Number(totalCount || 0));
  }
  if (!cachedViewerContext && summary && validViewerId) {
    writeCachedPostViewerContext(validViewerId, viewerContext);
  }

  const candidateRows = await fetchPostCandidatePool({
    where,
    replacements,
    viewerContext,
    viewerId: validViewerId,
    size,
    page,
    summary,
    profiler,
  });

  const creatorIds = candidateRows
    .map((row: any) => Number(row?.userId))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const shouldLoadCreatorProfiles = Boolean(
    viewerContext.cityId ||
      viewerContext.stateId ||
      viewerContext.countryId ||
      viewerContext.primaryLanguageCode ||
      viewerContext.secondaryLanguageCodes.size > 0
  );
  const creatorLocationMap = shouldLoadCreatorProfiles
    ? await loadCreatorLocationMap(creatorIds, profiler)
    : new Map<number, any>();

  const rerankStartedAtMs = nowMs();
  const qualityRejected: Array<{ id: number; creatorId: number; reason: string }> = [];
  const scoredCandidates: PostCandidate[] = [];
  const seenSessionCandidates: PostCandidate[] = [];
  candidateRows.forEach((row) => {
    const candidate = buildPostCandidate({
      row,
      viewerContext,
      viewerId: validViewerId,
      sessionState,
      creatorLocationMap,
    });
    if (candidate) {
      if (useSessionState && candidate.seenInSession) {
        seenSessionCandidates.push(candidate);
      } else {
        scoredCandidates.push(candidate);
      }
      return;
    }

    const reason = getPostQualityGateFailureReason(row) ?? "candidate_not_built";
    qualityRejected.push({
      id: Number(row?.id ?? 0) || 0,
      creatorId: Number(row?.userId ?? 0) || 0,
      reason,
    });
  });
  scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);
  seenSessionCandidates.sort((a, b) => b.finalScore - a.finalScore);

  const availableByBucket: Record<PostBucket, number> = {
    interest: 0,
    social: 0,
    trending: 0,
    local: 0,
    exploration: 0,
  };
  scoredCandidates.forEach((candidate) => {
    availableByBucket[candidate.bucket] += 1;
  });

  const bucketTargets = buildPostBucketTargets({
    desiredCount,
    availableByBucket,
    hasViewer: Boolean(validViewerId),
  });

  const selectedCandidates = selectPostCandidates({
    scoredCandidates,
    desiredCount,
    bucketTargets,
  });
  if (selectedCandidates.length < desiredCount && seenSessionCandidates.length > 0) {
    const remaining = desiredCount - selectedCandidates.length;
    const fallbackAvailableByBucket: Record<PostBucket, number> = {
      interest: 0,
      social: 0,
      trending: 0,
      local: 0,
      exploration: 0,
    };
    seenSessionCandidates.forEach((candidate) => {
      fallbackAvailableByBucket[candidate.bucket] += 1;
    });

    const fallbackTargets = buildPostBucketTargets({
      desiredCount: remaining,
      availableByBucket: fallbackAvailableByBucket,
      hasViewer: Boolean(validViewerId),
    });
    const fallbackSeenCandidates = selectPostCandidates({
      scoredCandidates: seenSessionCandidates,
      desiredCount: remaining,
      bucketTargets: fallbackTargets,
    });
    selectedCandidates.push(...fallbackSeenCandidates);
  }
  const shuffledCandidates = applyPostTopKShuffle(
    selectedCandidates,
    sessionToken || validViewerId
  );
  const rankedIds = shuffledCandidates
    .map((candidate) => Number(candidate.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const stableFeedIds = useSessionState
    ? mergeStablePostFeedIds(sessionState.stableFeedIds, rankedIds)
    : rankedIds;
  if (useSessionState) {
    sessionState.stableFeedIds = stableFeedIds;
  }
  const pageIds = stableFeedIds.slice(start, end);
  const pageIdSet = new Set<number>(pageIds);
  const pageCandidates = shuffledCandidates.filter((candidate) =>
    pageIdSet.has(Number(candidate.id))
  );
  profiler.rerankMs = nowMs() - rerankStartedAtMs;

  const orderedPosts = summary
    ? await fetchPostsByIdsOrderedSummary(pageIds, meId, profiler)
    : await fetchPostsByIdsOrdered(pageIds, meId, suggested, profiler);
  if (includeRankingDebug && Array.isArray(orderedPosts) && orderedPosts.length > 0) {
    const candidateById = new Map<number, PostCandidate>();
    [...scoredCandidates, ...seenSessionCandidates, ...selectedCandidates].forEach(
      (candidate) => {
        candidateById.set(Number(candidate.id), candidate);
      }
    );
    orderedPosts.forEach((post: any) => {
      const postId = Number(post?.id);
      if (!Number.isFinite(postId) || postId <= 0) return;
      const candidate = candidateById.get(postId);
      if (!candidate) return;
      const rankingReason = {
        ...candidate.rankingReason,
        format: candidate.format,
        bucket: candidate.bucket,
        scoreBreakdown: {
          ...candidate.scoreBreakdown,
        },
        score: round3(candidate.finalScore),
      };
      setRowValue(post, "score", round3(candidate.finalScore));
      setRowValue(post, "feed_score", round3(candidate.finalScore));
      setRowValue(post, "rankingReason", rankingReason);
      setRowValue(post, "ranking_reason", rankingReason);
    });
  }
  let sessionSaveBackend: "redis" | "memory" = "memory";
  if (useSessionState) {
    const sessionSaveStartedAtMs = nowMs();
    sessionSaveBackend = await updatePostSessionState(
      sessionMemoryKey,
      sessionState,
      orderedPosts
    );
    profiler.sessionSaveMs = nowMs() - sessionSaveStartedAtMs;
  }
  profiler.sessionSaveBackend = sessionSaveBackend;
  logPostFindDebug({
    viewerId: validViewerId,
    page,
    size,
    totalCount: Number(totalCount || 0),
    candidatePoolSize: candidateRows.length,
    qualityRejected,
    bucketTargets,
    scoredCandidates,
    selectedCandidates: useSessionState
      ? shuffledCandidates.filter((candidate) =>
          stableFeedIds.includes(Number(candidate.id))
        )
      : shuffledCandidates,
    pageCandidates,
  });
  logPostFindPerf({
    viewerId: validViewerId,
    page,
    size,
    totalCount: Number(totalCount || 0),
    candidatePoolSize: candidateRows.length,
    profiler,
  });

  return {
    count: Number(totalCount || 0),
    rows: orderedPosts,
  };
};

export const add = async (body: any) => {
  const hashtags = normalizeHashtagsForContent({
    text: body?.post,
    hashtagsRaw: body?.hashtags,
  });
  const post: any = await Post.create(body);

  const mediaItems = normalizeMediaPayload(body.media_items ?? body.media_url);
  if (mediaItems.length) {
    await Promise.all(
      mediaItems.map(async (item) => {
        await MediaPost.create({
          postId: post.id,
          url: item.url,
          is_img: item.is_img,
        });
      })
    );
  }

  const hashtagEntries = await syncHashtagsForContent({
    contentType: "post",
    contentId: post?.id,
    tags: hashtags,
  });
  if (typeof post?.setDataValue === "function") {
    post.setDataValue("hashtags", hashtagEntries);
  } else if (post) {
    post.hashtags = hashtagEntries;
  }

  return post;
};

export const all = async () => {
  const post = await Post.findAll({
    include: postInclude,
  });
  return post;
};

export const gets = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1,
  options: PostFeedOptions = {}
) => {
  return runPostFindRanking({
    pageRaw: page,
    sizeRaw: size,
    meId,
    suggested: false,
    options,
  });
};

export const getsSummary = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1,
  options: PostFeedOptions = {}
) => {
  return runPostFindRanking({
    pageRaw: page,
    sizeRaw: size,
    meId,
    suggested: false,
    options,
    summary: true,
  });
};

export const getsSuggested = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1,
  options: PostFeedOptions = {}
) => {
  return runPostFindRanking({
    pageRaw: page,
    sizeRaw: size,
    meId,
    suggested: true,
    options,
  });
};

export const getsSuggestedSummary = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1,
  options: PostFeedOptions = {}
) => {
  return runPostFindRanking({
    pageRaw: page,
    sizeRaw: size,
    meId,
    suggested: true,
    options,
    summary: true,
  });
};

export const getOne = async (id: any, meId: any) => {
  const post = await Post.findOne({
    where: {
      id,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: [(post as any)?.user].filter(Boolean),
    viewerIdRaw: meId,
  });

  if (post) {
    refreshPostRowMediaLinks(post);
    await applyPostHashtags([post]);
    await applyCommentHashtags(
      Array.isArray((post as any)?.comments) ? (post as any).comments : []
    );
  }

  return post;
};

export const get = async (id: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id,
      is_delete: false,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: [(post as any)?.user].filter(Boolean),
    viewerIdRaw: meId,
  });

  if (post) {
    refreshPostRowMediaLinks(post);
    await applyPostHashtags([post]);
    await applyCommentHashtags(
      Array.isArray((post as any)?.comments) ? (post as any).comments : []
    );
  }

  return post;
};

export const getOneByUser = async (id: any, userId: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id,
      userId,
      is_delete: false,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: [(post as any)?.user].filter(Boolean),
    viewerIdRaw: meId,
  });

  if (post) {
    refreshPostRowMediaLinks(post);
    await applyPostHashtags([post]);
    await applyCommentHashtags(
      Array.isArray((post as any)?.comments) ? (post as any).comments : []
    );
  }

  return post;
};

export const update = async (id: any, body: any) => {
  const postTemp = await Post.findByPk(id, {
    include: postInclude,
    attributes: { exclude: excludeKeys },
  });

  const post = await postTemp?.update(body);
  if (post) {
    const hashtags = normalizeHashtagsForContent({
      text: body?.post ?? (post as any)?.post,
      hashtagsRaw: body?.hashtags,
    });
    const hashtagEntries = await syncHashtagsForContent({
      contentType: "post",
      contentId: (post as any)?.id,
      tags: hashtags,
    });
    if (typeof (post as any)?.setDataValue === "function") {
      (post as any).setDataValue("hashtags", hashtagEntries);
    } else {
      (post as any).hashtags = hashtagEntries;
    }
  }
  return [post];
};

export const deletePost = async (id: any) => {
  const post = await Post.update({ is_delete: true }, { where: { id } });
  return post;
};

export const reportPost = async ({
  postIdRaw,
  reporterIdRaw,
  reason,
  details,
}: {
  postIdRaw: any;
  reporterIdRaw: any;
  reason: string;
  details?: string | null;
}) => {
  const postId = Number(postIdRaw);
  const reporterId = Number(reporterIdRaw);
  if (!Number.isFinite(postId) || postId <= 0) {
    return { notFound: true };
  }
  if (!Number.isFinite(reporterId) || reporterId <= 0) {
    return { invalidReporter: true };
  }

  const sequelize = (Post as any).sequelize;
  const normalizedDetails = String(details ?? "").trim().slice(0, 4000) || null;

  return sequelize.transaction(async (transaction: any) => {
    const post = await Post.findOne({
      where: { id: postId, is_delete: false },
      attributes: ["id", "userId", "is_delete"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!post) {
      return { notFound: true };
    }

    const ownerId = Number((post as any)?.userId ?? 0);
    if (ownerId > 0 && ownerId === reporterId) {
      return { selfReport: true };
    }

    const existing = await PostReport.findOne({
      where: { postId, reporterId },
      attributes: ["id"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    let alreadyReported = false;
    if (!existing) {
      try {
        await PostReport.create(
          {
            postId,
            reporterId,
            reason,
            details: normalizedDetails,
          },
          { transaction }
        );
      } catch (error: any) {
        if (error instanceof UniqueConstraintError) {
          alreadyReported = true;
        } else {
          throw error;
        }
      }
    } else {
      alreadyReported = true;
    }

    const reportsCount = await PostReport.count({
      where: { postId },
      distinct: true,
      col: "reporterId",
      transaction,
    });

    const shouldAutoDelete =
      Number(reportsCount) >= POST_REPORT_AUTO_DELETE_THRESHOLD &&
      !Boolean((post as any)?.is_delete);

    let autoDeleted = false;
    if (shouldAutoDelete) {
      await Post.update(
        {
          is_delete: true,
          deleted_date: new Date(new Date().toUTCString()),
        },
        {
          where: { id: postId },
          transaction,
        }
      );
      autoDeleted = true;
    }

    let ownerAutoDisabled = false;
    if (ownerId > 0 && reason === IMPERSONATION_REPORT_REASON) {
      const autoDisable = await autoDisableUserByImpersonationReports({
        userIdRaw: ownerId,
        transaction,
      });
      ownerAutoDisabled = Boolean(autoDisable?.disabledNow);
    }

    return {
      notFound: false,
      invalidReporter: false,
      selfReport: false,
      alreadyReported,
      reportsCount: Number(reportsCount) || 0,
      threshold: POST_REPORT_AUTO_DELETE_THRESHOLD,
      autoDeleted,
      ownerAutoDisabled,
      postId,
      ownerId,
    };
  });
};

export const toggleLike = async (userId: any, postId: any) => {
  const postNumericId = Number(postId);
  if (!Number.isFinite(postNumericId) || postNumericId <= 0) {
    return { notFound: true, liked: false, likesCount: 0 };
  }

  const post = await Post.findOne({
    where: { id: postNumericId, is_delete: false },
    attributes: ["id", "likes_count"],
  });
  if (!post) {
    return { notFound: true, liked: false, likesCount: 0 };
  }

  const existingFollow = await Like.findOne({
    where: { userId, postId: postNumericId },
  });

  if (existingFollow) {
    await existingFollow.destroy();
    await Post.update(
      {
        likes_count: Sequelize.literal(
          "GREATEST(COALESCE(likes_count, 0) - 1, 0)"
        ),
      },
      { where: { id: postNumericId } }
    );

    const refreshed = await Post.findByPk(postNumericId, {
      attributes: ["likes_count"],
    });
    return {
      notFound: false,
      liked: false,
      likesCount: toCounter((refreshed as any)?.likes_count),
    };
  } else {
    await Like.create({ userId, postId: postNumericId });
    await Post.increment({ likes_count: 1 }, { where: { id: postNumericId } });

    const refreshed = await Post.findByPk(postNumericId, {
      attributes: ["likes_count"],
    });
    return {
      notFound: false,
      liked: true,
      likesCount: toCounter((refreshed as any)?.likes_count),
    };
  }
};

export const sharePost = async (postIdRaw: any) => {
  const postId = Number(postIdRaw);
  if (!Number.isFinite(postId) || postId <= 0) {
    return { found: false, sharesCount: 0 };
  }

  const post = await Post.findOne({
    where: { id: postId, is_delete: false },
    attributes: ["id", "shares_count"],
  });
  if (!post) {
    return { found: false, sharesCount: 0 };
  }

  await Post.increment({ shares_count: 1 }, { where: { id: postId } });

  const refreshed = await Post.findByPk(postId, {
    attributes: ["shares_count"],
  });

  return {
    found: true,
    sharesCount: toCounter((refreshed as any)?.shares_count),
  };
};
