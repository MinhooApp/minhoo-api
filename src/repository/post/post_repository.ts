import Post from "../../_models/post/post";
import Like from "../../_models/like/like";
import { postInclude } from "./post_include";
import MediaPost from "../../_models/post/media_post";
import PostReport from "../../_models/post/post_report";
import { Op, Sequelize, UniqueConstraintError } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";
import Comment from "../../_models/comment/comment";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../libs/cache/find_session_store";
import { autoDisableUserByImpersonationReports } from "../user/user_repository";
import { attachActiveOrbitStateToUsers } from "../reel/orbit_ring_projection";

import { whereNotBlockedExists } from "../user/block_where";

const excludeKeys = ["createdAt", "updatedAt"];
const commentCountAttribute = [
  Sequelize.literal(
    "(SELECT COUNT(1) FROM comments c WHERE c.postId = `post`.`id` AND c.is_delete = 0)"
  ),
  "comments_count",
] as const;
const candidateCommentCountAttribute = Sequelize.literal(
  "(SELECT COUNT(1) FROM comments c WHERE c.postId = `post`.`id` AND c.is_delete = 0)"
);
const candidateMediaCountAttribute = Sequelize.literal(
  "(SELECT COUNT(1) FROM mediapost m WHERE m.postId = `post`.`id`)"
);
const candidateVideoCountAttribute = Sequelize.literal(
  "(SELECT COUNT(1) FROM mediapost m WHERE m.postId = `post`.`id` AND m.is_img = 0)"
);

const POST_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const POST_CREATOR_COOLDOWN = 8;
const POST_MAX_TOPIC_STREAK = 2;
const POST_MAX_FORMAT_STREAK = 2;
const POST_TOPK_SHUFFLE_WINDOW = 50;
const POST_REPORT_AUTO_DELETE_THRESHOLD = Math.max(
  1,
  Number(process.env.POST_REPORT_AUTO_DELETE_THRESHOLD ?? 10) || 10
);
const IMPERSONATION_REPORT_REASON = "impersonation_or_identity_fraud";

type PostFeedOptions = {
  sessionKey?: any;
};

type PostBucket = "interest" | "social" | "trending" | "local" | "exploration";
type PostSessionState = {
  updatedAt: number;
  seenPostIds: number[];
  recentCreatorIds: number[];
  recentTopicIds: number[];
  recentFormats: string[];
  creatorImpressions: Record<string, number>;
};
type PostViewerContext = {
  followedCreatorIds: Set<number>;
  interestCategoryIds: Set<number>;
  cityId: number | null;
  stateId: number | null;
  countryId: number | null;
};
type PostCandidate = {
  row: any;
  id: number;
  creatorId: number;
  categoryId: number;
  format: string;
  bucket: PostBucket;
  localScore: number;
  seenInSession: boolean;
  qualityPassed: boolean;
  finalScore: number;
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
  };
  excludedReason?: string;
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

const toPlain = (row: any) =>
  row && typeof row.toJSON === "function" ? row.toJSON() : row;

type MediaItem = { url: string; is_img: boolean };

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
        const url = entry.trim();
        if (!url) return null;
        return { url, is_img: true };
      }

      if (!entry || typeof entry !== "object") return null;
      const url = String(entry.url ?? entry.media_url ?? "").trim();
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

  const ttlSeconds = Math.max(60, Math.floor(POST_SESSION_TTL_MS / 1000));
  state.updatedAt = Date.now();
  return saveFindSessionState<PostSessionState>({
    scope: "post",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    state,
  });
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
    map.set(id, {
      cityId: Number(row?.city_residence_id ?? row?.cityId ?? 0) || null,
      stateId: Number(row?.state_residence_id ?? 0) || null,
      countryId: Number(row?.country_residence_id ?? row?.countryId ?? 0) || null,
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

const computeLocalScore = (
  viewerContext: PostViewerContext,
  creatorLocation: any
) => {
  if (!creatorLocation) return 0;
  const sameCity =
    viewerContext.cityId &&
    creatorLocation.cityId &&
    Number(viewerContext.cityId) === Number(creatorLocation.cityId);
  if (sameCity) return 1;

  const sameState =
    viewerContext.stateId &&
    creatorLocation.stateId &&
    Number(viewerContext.stateId) === Number(creatorLocation.stateId);
  if (sameState) return 0.75;

  const sameCountry =
    viewerContext.countryId &&
    creatorLocation.countryId &&
    Number(viewerContext.countryId) === Number(creatorLocation.countryId);
  if (sameCountry) return 0.45;

  return 0;
};

const fetchPostCandidatePool = async ({
  where,
  replacements,
  viewerContext,
  viewerId,
  size,
  page,
  profiler,
}: {
  where: any;
  replacements: Record<string, any>;
  viewerContext: PostViewerContext;
  viewerId: number | null;
  size: number;
  page: number;
  profiler?: PostFindProfiler;
}) => {
  const pageFactor = Math.max(1, page + 1);
  const basePoolSize = Math.min(
    380,
    Math.max(90, size * 10, pageFactor * size * 7)
  );
  const trendingPoolSize = Math.max(size * 4, Math.floor(basePoolSize * 0.6));
  const socialPoolSize = Math.max(size * 3, Math.floor(basePoolSize * 0.45));
  const explorationPoolSize = Math.max(size * 3, Math.floor(basePoolSize * 0.4));

  const followedIds = Array.from(viewerContext.followedCreatorIds.values());
  const excludedCreatorIds = toUniqueNumbers([...followedIds, viewerId ?? 0]);
  const categoryIds = Array.from(viewerContext.interestCategoryIds.values());

  const attributes: any[] = [
    "id",
    "userId",
    "categoryId",
    "created_date",
    "likes_count",
    "saves_count",
    "shares_count",
    "post",
    [candidateCommentCountAttribute, "comments_count"],
    [candidateMediaCountAttribute, "media_count"],
    [candidateVideoCountAttribute, "video_count"],
  ];

  const readRows = async (params: {
    label: string;
    extraWhere?: any;
    order: any[];
    limit: number;
  }) => {
    return withPostDbProfile(profiler, params.label, () =>
      Post.findAll({
        where: combineWhere(where, params.extraWhere),
        replacements,
        attributes,
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
        order: [["created_date", "DESC"], ["id", "DESC"]],
        limit: basePoolSize,
      }),
      readRows({
        label: "posts.findAll(candidate_trending)",
        order: [
          ["shares_count", "DESC"],
          ["saves_count", "DESC"],
          ["likes_count", "DESC"],
          [Sequelize.literal("comments_count"), "DESC"],
          ["created_date", "DESC"],
        ],
        limit: trendingPoolSize,
      }),
      followedIds.length
        ? readRows({
            label: "posts.findAll(candidate_social)",
            extraWhere: { userId: { [Op.in]: followedIds } },
            order: [["created_date", "DESC"], ["id", "DESC"]],
            limit: socialPoolSize,
          })
        : Promise.resolve([] as any[]),
      categoryIds.length
        ? readRows({
            label: "posts.findAll(candidate_interest)",
            extraWhere: { categoryId: { [Op.in]: categoryIds } },
            order: [["created_date", "DESC"], ["id", "DESC"]],
            limit: socialPoolSize,
          })
        : Promise.resolve([] as any[]),
      readRows({
        label: "posts.findAll(candidate_exploration)",
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
  sessionState,
  creatorLocationMap,
}: {
  row: any;
  viewerContext: PostViewerContext;
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
  const localScore = computeLocalScore(viewerContext, creatorLocationMap.get(creatorId));

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

  const finalScore =
    weightedBase +
    0.06 * localScore +
    0.04 * noveltyScore +
    0.03 * trendingScore -
    repetitionPenalty -
    topicPenalty -
    formatPenalty -
    fatiguePenalty -
    lowQualityPenalty;

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
    seenInSession,
    qualityPassed: true,
    finalScore,
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
            attributes: ["id", "name", "last_name", "username", "image_profil"],
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
      url: String(media?.url ?? ""),
      is_img: Boolean(media?.is_img),
    });
    mediaByPostId.set(postId, list);
  });

  const likesByPostId = new Map<number, any[]>();
  likeRows.forEach((like: any) => {
    const postId = Number(like?.postId);
    if (!Number.isFinite(postId) || postId <= 0) return;
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
      media_url: plainComment?.media_url ?? null,
      created_date: plainComment?.created_date ?? null,
      commentator: plainComment?.commentator ?? null,
    });
    commentsByPostId.set(postId, list);
  });

  posts.forEach((post: any) => {
    const postId = Number(post?.id);
    const userId = Number(post?.userId);
    const rawUser = userById.get(userId) ?? null;
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
  });

  const byId = new Map<number, any>();
  posts.forEach((post: any) => {
    byId.set(Number(post?.id), post);
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
        [candidateCommentCountAttribute, "comments_count"],
      ],
    })
  );

  if (!posts.length) return [];

  const userIds = toUniqueNumbers(posts.map((post: any) => Number(post?.userId)));
  const viewerId = Number(meId);
  const validViewerId = Number.isFinite(viewerId) && viewerId > 0 ? viewerId : null;

  const [users, mediaRows, viewerLikes] = await Promise.all([
    userIds.length
      ? withPostDbProfile(profiler, "users.findAll(hydrate_users_summary)", () =>
          User.findAll({
            where: { id: { [Op.in]: userIds } },
            attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
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
      url: String(media?.url ?? ""),
      is_img: Boolean(media?.is_img),
    });
  });

  const likedPostIds = new Set<number>();
  viewerLikes.forEach((like: any) => {
    const postId = Number(like?.postId);
    if (Number.isFinite(postId) && postId > 0) likedPostIds.add(postId);
  });

  await attachActiveOrbitStateToUsers({
    usersRaw: Array.from(userById.values()),
    viewerIdRaw: meId,
  });

  const byId = new Map<number, any>();
  posts.forEach((post: any) => {
    const postId = Number(post?.id);
    const userId = Number(post?.userId);
    post.setDataValue("user", userById.get(userId) ?? null);
    post.setDataValue("post_media", mediaByPostId.has(postId) ? [mediaByPostId.get(postId)] : []);
    post.setDataValue("likes", []);
    post.setDataValue("comments", []);
    post.setDataValue("is_liked", likedPostIds.has(postId));
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
  const sessionToken = normalizeSessionToken(options?.sessionKey);
  const sessionMemoryKey = buildPostSessionMemoryKey(validViewerId, sessionToken);
  const sessionLoadStartedAtMs = nowMs();
  const {
    state: sessionState,
    backend: sessionLoadBackend,
  } = await getPostSessionState(sessionMemoryKey);
  profiler.sessionLoadMs = nowMs() - sessionLoadStartedAtMs;
  profiler.sessionLoadBackend = sessionLoadBackend;
  const start = page * size;
  const end = start + size;
  const desiredCount = Math.max(end, size);

  const where = buildPostFeedWhere(meId, suggested);
  const replacements = { meId };

  const [totalCount, viewerContext] = await Promise.all([
    withPostDbProfile(profiler, "posts.count(feed_total)", () =>
      Post.count({
        where,
        replacements,
        distinct: true,
        col: "id",
      } as any)
    ),
    loadPostViewerContext(validViewerId, profiler),
  ]);

  const candidateRows = await fetchPostCandidatePool({
    where,
    replacements,
    viewerContext,
    viewerId: validViewerId,
    size,
    page,
    profiler,
  });

  const creatorIds = candidateRows
    .map((row: any) => Number(row?.userId))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  const creatorLocationMap = await loadCreatorLocationMap(creatorIds, profiler);

  const rerankStartedAtMs = nowMs();
  const qualityRejected: Array<{ id: number; creatorId: number; reason: string }> = [];
  const scoredCandidates: PostCandidate[] = [];
  candidateRows.forEach((row) => {
    const candidate = buildPostCandidate({
      row,
      viewerContext,
      sessionState,
      creatorLocationMap,
    });
    if (candidate) {
      scoredCandidates.push(candidate);
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
  const shuffledCandidates = applyPostTopKShuffle(
    selectedCandidates,
    sessionToken || validViewerId
  );
  const pageCandidates = shuffledCandidates.slice(start, end);
  profiler.rerankMs = nowMs() - rerankStartedAtMs;
  const pageIds = pageCandidates.map((candidate) => candidate.id);

  const orderedPosts = summary
    ? await fetchPostsByIdsOrderedSummary(pageIds, meId, profiler)
    : await fetchPostsByIdsOrdered(pageIds, meId, suggested, profiler);
  const sessionSaveStartedAtMs = nowMs();
  const sessionSaveBackend = await updatePostSessionState(
    sessionMemoryKey,
    sessionState,
    orderedPosts
  );
  profiler.sessionSaveMs = nowMs() - sessionSaveStartedAtMs;
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
    selectedCandidates: shuffledCandidates,
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

  return post;
};

export const update = async (id: any, body: any) => {
  const postTemp = await Post.findByPk(id, {
    include: postInclude,
    attributes: { exclude: excludeKeys },
  });

  const post = await postTemp?.update(body);
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
