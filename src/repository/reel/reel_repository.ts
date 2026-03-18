import { Op, Sequelize, UniqueConstraintError } from "sequelize";
import Reel from "../../_models/reel/reel";
import ReelLike from "../../_models/reel/reel_like";
import ReelSave from "../../_models/reel/reel_save";
import ReelView from "../../_models/reel/reel_view";
import ReelComment from "../../_models/reel/reel_comment";
import ReelReport from "../../_models/reel/reel_report";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";
import {
  whereNotBlockedExists,
  whereNotBlockedProfileExists,
} from "../user/block_where";
import {
  loadFindSessionState,
  saveFindSessionState,
} from "../../libs/cache/find_session_store";

const reelUserInclude = {
  model: User,
  as: "user",
  attributes: [
    "id",
    "name",
    "last_name",
    "username",
    "image_profil",
    "job_categories_labels",
  ],
};

const reelUserSummaryInclude = {
  model: User,
  as: "user",
  attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
};

const normalizeNumber = (value: any, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
};

const normalizeLimit = (value: any, fallback = 15, max = 40) => {
  const n = Math.floor(normalizeNumber(value, fallback));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = Math.floor(normalizeNumber(value, fallback));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const normalizeUserId = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const clamp01 = (value: number) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const normalizeSessionToken = (value: any): string => {
  const token = String(value ?? "")
    .trim()
    .replace(/[^\w\-:.]/g, "")
    .slice(0, 128);
  return token;
};

const normalizeTextToken = (value: any): string => {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 64);
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

const toUniqueNumbers = (values: any[]): number[] => {
  const unique = new Set<number>();
  values.forEach((value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) unique.add(Math.floor(n));
  });
  return Array.from(unique.values());
};

const toUniqueTextTokens = (values: any[]): string[] => {
  const unique = new Set<string>();
  values.forEach((value) => {
    const token = normalizeTextToken(value);
    if (token) unique.add(token);
  });
  return Array.from(unique.values());
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

const ORBIT_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const ORBIT_RECENT_VIEW_DAYS = 2;
const ORBIT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const ORBIT_CREATOR_COOLDOWN = 5;
const ORBIT_MAX_TOPIC_STREAK = 2;
const ORBIT_NEW_CREATOR_EVERY = 6;
const ORBIT_TOPK_SHUFFLE_WINDOW = 40;
const REEL_REPORT_AUTO_DELETE_THRESHOLD = Math.max(
  1,
  Number(process.env.REEL_REPORT_AUTO_DELETE_THRESHOLD ?? 10) || 10
);

type OrbitBucket = "affinity" | "trending" | "social" | "exploration";
type OrbitListFeedOptions = {
  sessionKey?: any;
};

type OrbitSessionState = {
  updatedAt: number;
  seenReelIds: number[];
  recentCreatorIds: number[];
  recentPrimaryTopics: string[];
  creatorImpressions: Record<string, number>;
};

type OrbitViewerContext = {
  followedCreatorIds: Set<number>;
  interestLabels: Set<string>;
};

type OrbitCandidate = {
  row: any;
  id: number;
  creatorId: number;
  primaryTopic: string;
  topicKeys: string[];
  bucket: OrbitBucket;
  trendingScore: number;
  viralScore: number;
  seenInSession: boolean;
  recentlyViewed: boolean;
  qualityPassed: boolean;
  finalScore: number;
  scoreBreakdown: {
    watchProxy: number;
    interest: number;
    freshness: number;
    saveShare: number;
    social: number;
    exploration: number;
    quality: number;
    novelty: number;
    trending: number;
    weightedBase: number;
    creatorPenalty: number;
    topicPenalty: number;
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

type OrbitDbQueryStat = {
  label: string;
  ms: number;
};

type OrbitFindProfiler = {
  enabled: boolean;
  startedAtMs: number;
  dbQueries: OrbitDbQueryStat[];
  rerankMs: number;
  sessionLoadMs: number;
  sessionSaveMs: number;
  sessionLoadBackend: "redis" | "memory" | null;
  sessionSaveBackend: "redis" | "memory" | null;
};

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

const createOrbitFindProfiler = (): OrbitFindProfiler => ({
  enabled: shouldCollectFindProfile(),
  startedAtMs: nowMs(),
  dbQueries: [],
  rerankMs: 0,
  sessionLoadMs: 0,
  sessionSaveMs: 0,
  sessionLoadBackend: null,
  sessionSaveBackend: null,
});

const withOrbitDbProfile = async <T>(
  profiler: OrbitFindProfiler | null | undefined,
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

const toValidDate = (value: any): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const resolveReelRingUntilDate = (reel: any): Date | null => {
  const persistedRingUntil = toValidDate(reel?.new_until ?? reel?.newUntil);
  if (persistedRingUntil) return persistedRingUntil;

  const createdAt = toValidDate(reel?.createdAt ?? reel?.created_at);
  if (!createdAt) return null;

  return new Date(createdAt.getTime() + ORBIT_NEW_WINDOW_MS);
};

const buildReelFreshness = (reel: any) => {
  const createdAt = toValidDate(reel?.createdAt ?? reel?.created_at);
  const ringUntilDate = resolveReelRingUntilDate(reel);
  const ringUntil = ringUntilDate ? ringUntilDate.toISOString() : null;
  const ringActive = ringUntilDate ? ringUntilDate.getTime() > Date.now() : false;

  return {
    ringActive,
    ringUntil,
    isNew: ringActive,
    newUntil: ringUntil,
    createdAtIso: createdAt ? createdAt.toISOString() : null,
  };
};

const buildUserOrbitRingStatus = (lastOrbitAtRaw: any) => {
  const lastOrbitAt = toValidDate(lastOrbitAtRaw);
  if (!lastOrbitAt) {
    return {
      hasOrbitRing: false,
      orbitRingUntil: null as string | null,
      orbitLastAt: null as string | null,
    };
  }

  const orbitRingUntilDate = new Date(lastOrbitAt.getTime() + ORBIT_NEW_WINDOW_MS);
  return {
    hasOrbitRing: orbitRingUntilDate.getTime() > Date.now(),
    orbitRingUntil: orbitRingUntilDate.toISOString(),
    orbitLastAt: lastOrbitAt.toISOString(),
  };
};

const getStreamPlaybackBaseUrl = () => {
  const raw = String(
    process.env.CLOUDFLARE_STREAM_PLAYBACK_BASE_URL ??
      process.env.CLOUDFLARE_STREAM_PLAYBACK_HOST ??
      ""
  )
    .trim()
    .replace(/\/+$/, "");
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
};

const buildDefaultStreamUrl = (videoUidRaw: any) => {
  const videoUid = String(videoUidRaw ?? "").trim();
  if (!videoUid) return null;
  const baseUrl = getStreamPlaybackBaseUrl();
  if (baseUrl) return `${baseUrl}/${videoUid}/manifest/video.m3u8`;
  return `https://videodelivery.net/${videoUid}/manifest/video.m3u8`;
};

const buildDefaultThumbnailUrl = (videoUidRaw: any) => {
  const videoUid = String(videoUidRaw ?? "").trim();
  return videoUid
    ? `https://videodelivery.net/${videoUid}/thumbnails/thumbnail.jpg?time=1s`
    : null;
};

const normalizePlaybackType = (streamUrl: string | null) => {
  if (!streamUrl) return null;
  return String(streamUrl).toLowerCase().includes('.m3u8') ? 'hls' : 'url';
};

const normalizeMediaType = (reel: any) => {
  const metadata = reel?.metadata && typeof reel.metadata === 'object' ? reel.metadata : {};
  const explicit = String(metadata?.media_type ?? metadata?.mediaType ?? '').trim().toLowerCase();
  if (explicit === 'image' || explicit === 'video') return explicit;

  const streamUrl = String(reel?.stream_url ?? '').trim().toLowerCase();
  if (streamUrl.includes('/api/v1/media/image/play') || streamUrl.includes('imagedelivery.net')) {
    return 'image';
  }
  return 'video';
};

const buildPlaybackState = (reel: any) => {
  const status = String(reel?.status ?? 'ready').trim().toLowerCase();
  const mediaType = normalizeMediaType(reel);
  const metadata = reel?.metadata && typeof reel.metadata === 'object' ? reel.metadata : {};
  const storedStreamUrl = String(reel?.stream_url ?? '').trim();
  const directHlsUrl = mediaType === 'video' ? buildDefaultStreamUrl(reel?.video_uid) : null;
  const storedImageUrl = String(metadata?.image_url ?? metadata?.imageUrl ?? '').trim();
  const shouldPreferDirectHls =
    mediaType === 'video' &&
    Boolean(directHlsUrl) &&
    (!storedStreamUrl || storedStreamUrl.startsWith('/api/v1/media/video/play'));
  const streamUrl = mediaType === 'image'
    ? storedImageUrl || storedStreamUrl || null
    : shouldPreferDirectHls
    ? directHlsUrl
    : storedStreamUrl || directHlsUrl;
  const thumbnailUrl = mediaType === 'image'
    ? String(reel?.thumbnail_url ?? '').trim() || storedImageUrl || storedStreamUrl || null
    : String(reel?.thumbnail_url ?? '').trim() || buildDefaultThumbnailUrl(reel?.video_uid);
  const downloadUrl = mediaType === 'image'
    ? String(reel?.download_url ?? '').trim() || storedImageUrl || storedStreamUrl || null
    : String(reel?.download_url ?? '').trim() || null;
  const durationSeconds = mediaType === 'image'
    ? 0
    : Math.max(0, Number(reel?.duration_seconds ?? reel?.durationSeconds ?? 0) || 0);
  const isReady = status === 'ready' && Boolean(streamUrl || thumbnailUrl);
  const playbackReady = mediaType === 'video' ? isReady : false;
  const preloadKey = `orbit:${Number(reel?.id ?? 0)}:${String(reel?.updatedAt ?? reel?.updated_at ?? reel?.createdAt ?? reel?.created_at ?? '')}`;

  return {
    status,
    mediaType,
    streamUrl,
    imageUrl: mediaType === 'image' ? streamUrl || thumbnailUrl : null,
    thumbnailUrl,
    downloadUrl,
    durationSeconds,
    durationMs: durationSeconds * 1000,
    isReady,
    playbackReady,
    type: mediaType === 'image' ? 'image' : normalizePlaybackType(streamUrl),
    preloadKey,
  };
};

const setDataValue = (row: any, key: string, value: any) => {
  if (!row) return;
  if (typeof row.setDataValue === "function") {
    row.setDataValue(key, value);
  } else {
    row[key] = value;
  }
};

const toPlain = (row: any) =>
  row && typeof row.toJSON === "function" ? row.toJSON() : row;

const withFlagAliases = (row: any) => {
  if (!row) return row;
  const reel = toPlain(row);
  const isStarred = Boolean(reel?.isStarred ?? reel?.is_starred ?? reel?.is_liked);
  const isSaved = Boolean(reel?.isSaved ?? reel?.is_saved);
  const freshness = buildReelFreshness(reel);
  const playback = buildPlaybackState(reel);

  const user = reel?.user && typeof reel.user === "object" ? reel.user : null;
  const fallbackUserRing = buildUserOrbitRingStatus(reel?.createdAt);
  const hasOrbitRing = Boolean(
    user?.hasOrbitRing ?? user?.has_orbit_ring ?? fallbackUserRing.hasOrbitRing
  );
  const orbitRingUntil =
    user?.orbitRingUntil ??
    user?.orbit_ring_until ??
    fallbackUserRing.orbitRingUntil;
  const orbitLastAt =
    user?.orbitLastAt ?? user?.orbit_last_at ?? fallbackUserRing.orbitLastAt;

  const rawStreamUrl = String(reel?.stream_url ?? '').trim() || null;
  const effectiveStreamUrl = playback.streamUrl || rawStreamUrl;

  return {
    ...reel,
    status: playback.status,
    media_type: playback.mediaType,
    mediaType: playback.mediaType,
    stream_url: effectiveStreamUrl,
    streamUrl: effectiveStreamUrl,
    image_url: playback.imageUrl,
    imageUrl: playback.imageUrl,
    media_url: playback.mediaType === 'image' ? playback.imageUrl : effectiveStreamUrl,
    mediaUrl: playback.mediaType === 'image' ? playback.imageUrl : effectiveStreamUrl,
    playback_url: playback.streamUrl,
    playbackUrl: playback.streamUrl,
    thumbnail_url: playback.thumbnailUrl,
    thumbnailUrl: playback.thumbnailUrl,
    poster_url: playback.thumbnailUrl,
    posterUrl: playback.thumbnailUrl,
    download_url: playback.downloadUrl,
    downloadUrl: playback.downloadUrl,
    duration_seconds: playback.durationSeconds,
    durationSeconds: playback.durationSeconds,
    duration_ms: playback.durationMs,
    durationMs: playback.durationMs,
    media_ready: playback.isReady,
    mediaReady: playback.isReady,
    playback_ready: playback.playbackReady,
    playbackReady: playback.playbackReady,
    can_play: playback.playbackReady,
    canPlay: playback.playbackReady,
    playback_type: playback.type,
    playbackType: playback.type,
    preload_key: playback.preloadKey,
    preloadKey: playback.preloadKey,
    playback: {
      url: playback.streamUrl,
      stream_url: playback.streamUrl,
      streamUrl: playback.streamUrl,
      image_url: playback.imageUrl,
      imageUrl: playback.imageUrl,
      thumbnail_url: playback.thumbnailUrl,
      thumbnailUrl: playback.thumbnailUrl,
      poster_url: playback.thumbnailUrl,
      posterUrl: playback.thumbnailUrl,
      download_url: playback.downloadUrl,
      downloadUrl: playback.downloadUrl,
      duration_seconds: playback.durationSeconds,
      durationSeconds: playback.durationSeconds,
      duration_ms: playback.durationMs,
      durationMs: playback.durationMs,
      ready: playback.playbackReady,
      is_ready: playback.playbackReady,
      isReady: playback.playbackReady,
      media_ready: playback.isReady,
      mediaReady: playback.isReady,
      media_type: playback.mediaType,
      mediaType: playback.mediaType,
      type: playback.type,
      preload_key: playback.preloadKey,
      preloadKey: playback.preloadKey,
    },
    ...(user
      ? {
          user: {
            ...user,
            has_orbit_ring: hasOrbitRing,
            hasOrbitRing: hasOrbitRing,
            orbit_ring_until: orbitRingUntil ?? null,
            orbitRingUntil: orbitRingUntil ?? null,
            orbit_last_at: orbitLastAt ?? null,
            orbitLastAt: orbitLastAt ?? null,
          },
        }
      : {}),
    is_starred: isStarred,
    is_liked: isStarred,
    is_saved: isSaved,
    isStarred,
    isLiked: isStarred,
    isSaved,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
  };
};

const mapWithFlagAliases = (rows: any[]) => {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => withFlagAliases(row));
};

const setInteractionFlags = (
  reel: any,
  {
    isStarred,
    isSaved,
  }: {
    isStarred: boolean;
    isSaved: boolean;
  }
) => {
  setDataValue(reel, "is_starred", isStarred);
  setDataValue(reel, "is_liked", isStarred);
  setDataValue(reel, "is_saved", isSaved);

  // camelCase aliases for clients that map Orbit flags in JS style
  setDataValue(reel, "isStarred", isStarred);
  setDataValue(reel, "isLiked", isStarred);
  setDataValue(reel, "isSaved", isSaved);
};

const buildFollowersVisibilityLiteral = () =>
  Sequelize.literal(`
    (
      \`reel\`.\`visibility\` = 'followers'
      AND EXISTS (
        SELECT 1
        FROM followers f
        WHERE f.userId = \`reel\`.\`userId\`
          AND f.followerId = :meId
      )
    )
  `);

const buildFeedWhere = (viewerIdRaw: any) => {
  const viewerId = normalizeUserId(viewerIdRaw);
  const blockedWhere: any = whereNotBlockedExists(viewerId, "`reel`.`userId`");

  if (!viewerId) {
    return {
      is_delete: false,
      status: 'ready',
      visibility: "public",
      ...(blockedWhere || {}),
    };
  }

  const andClauses: any[] = [];
  const blockedAnd = blockedWhere?.[Op.and];
  if (Array.isArray(blockedAnd) && blockedAnd.length) {
    andClauses.push(...blockedAnd);
  }

  andClauses.push({
    [Op.or]: [
      { visibility: "public" },
      { userId: viewerId },
      buildFollowersVisibilityLiteral(),
    ],
  });

  return {
    is_delete: false,
    status: 'ready',
    [Op.and]: andClauses,
  };
};

const attachInteractionFlags = async (
  viewerIdRaw: any,
  reels: any[],
  profiler?: OrbitFindProfiler
) => {
  const viewerId = normalizeUserId(viewerIdRaw);
  if (!Array.isArray(reels) || !reels.length) return;

  const reelIds = reels
    .map((reel) => Number(reel?.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!viewerId || !reelIds.length) {
    reels.forEach((reel) => {
      setInteractionFlags(reel, { isStarred: false, isSaved: false });
    });
    return;
  }

  const [likes, saves] = await Promise.all([
    withOrbitDbProfile(profiler, "reel_likes.findAll(interaction_flags)", () =>
      ReelLike.findAll({
        where: { userId: viewerId, reelId: { [Op.in]: reelIds } },
        attributes: ["reelId"],
      })
    ),
    withOrbitDbProfile(profiler, "reel_saves.findAll(interaction_flags)", () =>
      ReelSave.findAll({
        where: { userId: viewerId, reelId: { [Op.in]: reelIds } },
        attributes: ["reelId"],
      })
    ),
  ]);

  const liked = new Set<number>(likes.map((r: any) => Number(r.reelId)));
  const saved = new Set<number>(saves.map((r: any) => Number(r.reelId)));

  reels.forEach((reel) => {
    const reelId = Number(reel?.id);
    const isLiked = liked.has(reelId);
    const isSaved = saved.has(reelId);
    setInteractionFlags(reel, { isStarred: isLiked, isSaved });
  });
};

const loadLatestOrbitAtByUserIds = async (
  userIdsRaw: number[],
  profiler?: OrbitFindProfiler
) => {
  const userIds = [...new Set(userIdsRaw.filter((id) => Number.isFinite(id) && id > 0))];
  if (!userIds.length) return new Map<number, Date>();

  const rows = await withOrbitDbProfile(
    profiler,
    "reels.findAll(latest_orbit_by_user)",
    () =>
      Reel.findAll({
        attributes: [
          "userId",
          [Sequelize.fn("MAX", Sequelize.col("createdAt")), "lastOrbitAt"],
        ],
        where: {
          is_delete: false,
          status: 'ready',
          userId: { [Op.in]: userIds },
        },
        group: ["userId"],
        raw: true,
      })
  );

  const map = new Map<number, Date>();
  rows.forEach((row: any) => {
    const userId = Number(row?.userId);
    const lastOrbitAt = toValidDate(row?.lastOrbitAt);
    if (userId > 0 && lastOrbitAt) {
      map.set(userId, lastOrbitAt);
    }
  });

  return map;
};

const attachUserOrbitRing = async (reels: any[], profiler?: OrbitFindProfiler) => {
  if (!Array.isArray(reels) || !reels.length) return;

  const userIds = reels
    .map((reel) => Number((reel as any)?.user?.id ?? (reel as any)?.userId))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!userIds.length) return;

  const latestOrbitByUserId = await loadLatestOrbitAtByUserIds(userIds, profiler);

  reels.forEach((reel) => {
    const user = (reel as any)?.user;
    const userId = Number((user as any)?.id ?? (reel as any)?.userId);
    if (!user || !Number.isFinite(userId) || userId <= 0) return;

    const ringStatus = buildUserOrbitRingStatus(latestOrbitByUserId.get(userId) ?? null);
    setDataValue(user, "has_orbit_ring", ringStatus.hasOrbitRing);
    setDataValue(user, "hasOrbitRing", ringStatus.hasOrbitRing);
    setDataValue(user, "orbit_ring_until", ringStatus.orbitRingUntil);
    setDataValue(user, "orbitRingUntil", ringStatus.orbitRingUntil);
    setDataValue(user, "orbit_last_at", ringStatus.orbitLastAt);
    setDataValue(user, "orbitLastAt", ringStatus.orbitLastAt);
  });
};

const toDateOnlyDaysAgo = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Math.max(0, Math.floor(days)));
  return date.toISOString().slice(0, 10);
};

const buildOrbitSessionMemoryKey = (
  viewerId: number | null,
  sessionTokenRaw: any
) => {
  const sessionToken = normalizeSessionToken(sessionTokenRaw);
  if (viewerId && sessionToken) return `u:${viewerId}:${sessionToken}`;
  if (viewerId) return `u:${viewerId}`;
  if (sessionToken) return `a:${sessionToken}`;
  return "";
};

const buildEmptyOrbitSessionState = (): OrbitSessionState => {
  return {
    updatedAt: Date.now(),
    seenReelIds: [],
    recentCreatorIds: [],
    recentPrimaryTopics: [],
    creatorImpressions: {},
  };
};

const getOrbitSessionState = async (
  sessionMemoryKey: string
): Promise<{ state: OrbitSessionState; backend: "redis" | "memory" }> => {
  if (!sessionMemoryKey) {
    return { state: buildEmptyOrbitSessionState(), backend: "memory" };
  }

  const ttlSeconds = Math.max(60, Math.floor(ORBIT_SESSION_TTL_MS / 1000));
  const loaded = await loadFindSessionState<OrbitSessionState>({
    scope: "orbit",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    initialState: buildEmptyOrbitSessionState(),
  });

  const state = loaded.state ?? buildEmptyOrbitSessionState();
  state.updatedAt = Date.now();

  return {
    state,
    backend: loaded.backend,
  };
};

const pushUniqueLimited = (list: any[], value: any, maxLength: number) => {
  if (value === undefined || value === null || value === "") return;
  const existingIndex = list.findIndex((item) => item === value);
  if (existingIndex >= 0) {
    list.splice(existingIndex, 1);
  }
  list.unshift(value);
  if (list.length > maxLength) list.length = maxLength;
};

const updateOrbitSessionState = async (
  sessionMemoryKey: string,
  sessionState: OrbitSessionState,
  selectedRows: any[]
) => {
  if (!sessionMemoryKey) return "memory" as const;
  const state = sessionState;

  if (Array.isArray(selectedRows) && selectedRows.length) {
    selectedRows.forEach((row) => {
      const reelId = Number(row?.id);
      const creatorId = Number(row?.user?.id ?? row?.userId);
      if (Number.isFinite(reelId) && reelId > 0) {
        pushUniqueLimited(state.seenReelIds, reelId, 400);
      }
      if (Number.isFinite(creatorId) && creatorId > 0) {
        pushUniqueLimited(state.recentCreatorIds, creatorId, 60);
        const key = String(creatorId);
        state.creatorImpressions[key] = Math.min(
          999,
          Number(state.creatorImpressions[key] ?? 0) + 1
        );
      }

      const topics = extractReelTopicKeys(row);
      const primaryTopic = topics[0] ?? "";
      if (primaryTopic) {
        pushUniqueLimited(state.recentPrimaryTopics, primaryTopic, 80);
      }
    });
  }

  state.updatedAt = Date.now();
  const ttlSeconds = Math.max(60, Math.floor(ORBIT_SESSION_TTL_MS / 1000));
  return saveFindSessionState<OrbitSessionState>({
    scope: "orbit",
    sessionKey: sessionMemoryKey,
    ttlSeconds,
    state,
  });
};

const toEngagementCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

const extractReelTopicKeys = (reel: any): string[] => {
  if (!reel) return [];
  const user = reel?.user ?? {};
  const metadata = reel?.metadata && typeof reel.metadata === "object" ? reel.metadata : {};

  const labelValues = [
    ...parseJsonArray(user?.job_categories_labels),
    ...parseJsonArray(metadata?.topic_labels),
    ...parseJsonArray(metadata?.topics),
  ];
  const labels = toUniqueTextTokens(labelValues);

  const hashtagMatches = String(reel?.description ?? "").match(/#[a-z0-9_]+/gi) ?? [];
  const hashtags = hashtagMatches.map((tag) => normalizeTextToken(String(tag).replace(/^#/, "")));

  const mediaType = normalizeTextToken(
    metadata?.media_type ?? metadata?.mediaType ?? normalizeMediaType(reel)
  );
  const mediaTopic = mediaType ? [`media:${mediaType}`] : [];

  const unique = new Set<string>([...labels, ...hashtags, ...mediaTopic].filter(Boolean));
  if (!unique.size) unique.add("general");
  return Array.from(unique.values()).slice(0, 8);
};

const computeLabelOverlap = (interestSet: Set<string>, labels: string[]) => {
  if (!interestSet.size || !labels.length) return 0;
  let hits = 0;
  labels.forEach((label) => {
    if (interestSet.has(label)) hits += 1;
  });
  const denominator = Math.min(labels.length, Math.max(interestSet.size, 1));
  return clamp01(hits / Math.max(1, denominator));
};

const loadOrbitViewerContext = async (
  viewerId: number | null,
  profiler?: OrbitFindProfiler
): Promise<OrbitViewerContext> => {
  const context: OrbitViewerContext = {
    followedCreatorIds: new Set<number>(),
    interestLabels: new Set<string>(),
  };

  if (!viewerId) return context;

  const [followRows, viewer] = await Promise.all([
    withOrbitDbProfile(profiler, "followers.findAll(viewer_follows)", () =>
      Follower.findAll({
        where: { followerId: viewerId },
        attributes: ["userId"],
        raw: true,
      })
    ),
    withOrbitDbProfile(profiler, "users.findByPk(viewer_context)", () =>
      User.findByPk(viewerId, {
        attributes: ["id", "job_category_ids", "job_categories_labels"],
      })
    ),
  ]);

  followRows.forEach((row: any) => {
    const creatorId = Number(row?.userId);
    if (Number.isFinite(creatorId) && creatorId > 0) {
      context.followedCreatorIds.add(creatorId);
    }
  });

  const labelTokens = toUniqueTextTokens([
    ...parseJsonArray((viewer as any)?.job_categories_labels),
    ...parseJsonArray((viewer as any)?.job_category_ids),
  ]);
  labelTokens.forEach((token) => context.interestLabels.add(token));

  return context;
};

const loadRecentlyViewedOrbitIds = async (
  viewerId: number | null,
  sessionTokenRaw: any,
  profiler?: OrbitFindProfiler
) => {
  const sessionToken = normalizeSessionToken(sessionTokenRaw);
  if (!viewerId && !sessionToken) return new Set<number>();

  const where: any = {
    viewed_date: { [Op.gte]: toDateOnlyDaysAgo(ORBIT_RECENT_VIEW_DAYS) },
  };
  if (viewerId) {
    where.userId = viewerId;
  } else {
    where.session_key = sessionToken;
  }

  const rows = await withOrbitDbProfile(profiler, "reel_views.findAll(recent_views)", () =>
    ReelView.findAll({
      where,
      attributes: ["reelId"],
      raw: true,
      limit: 1500,
    })
  );

  return new Set<number>(
    rows
      .map((row: any) => Number(row?.reelId))
      .filter((id: number) => Number.isFinite(id) && id > 0)
  );
};

const mergeFeedWhere = (baseWhere: any, extraWhere?: any) => {
  if (!extraWhere || !Object.keys(extraWhere).length) return baseWhere;
  return {
    [Op.and]: [baseWhere, extraWhere],
  };
};

const fetchOrbitCandidatePool = async ({
  where,
  viewerId,
  size,
  page,
  followedCreatorIds,
  profiler,
  summary = false,
}: {
  where: any;
  viewerId: number | null;
  size: number;
  page: number;
  followedCreatorIds: Set<number>;
  profiler?: OrbitFindProfiler;
  summary?: boolean;
}) => {
  const pageFactor = Math.max(1, page + 1);
  const basePoolSize = Math.min(
    380,
    Math.max(80, size * 8, pageFactor * size * 6)
  );
  const trendingPoolSize = Math.max(size * 3, Math.floor(basePoolSize * 0.55));
  const socialPoolSize = Math.max(size * 3, Math.floor(basePoolSize * 0.45));
  const explorationPoolSize = Math.max(size * 2, Math.floor(basePoolSize * 0.35));

  const followedIds = Array.from(followedCreatorIds.values());
  const excludedCreatorIds = toUniqueNumbers([...followedIds, viewerId ?? 0]);

  const readRows = async (params: {
    label: string;
    extraWhere?: any;
    order: any[];
    limit: number;
  }) => {
    return withOrbitDbProfile(profiler, params.label, () =>
      Reel.findAll({
        where: mergeFeedWhere(where, params.extraWhere),
        include: [summary ? reelUserSummaryInclude : reelUserInclude],
        replacements: { meId: viewerId ?? -1 },
        order: params.order,
        limit: Math.max(1, Math.floor(params.limit)),
      })
    );
  };

  const [recentRows, trendingRows, socialRows, explorationRows] = await Promise.all([
    readRows({
      label: "reels.findAll(candidate_recent)",
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: basePoolSize,
    }),
    readRows({
      label: "reels.findAll(candidate_trending)",
      order: [
        ["shares_count", "DESC"],
        ["saves_count", "DESC"],
        ["likes_count", "DESC"],
        ["comments_count", "DESC"],
        ["views_count", "DESC"],
        ["createdAt", "DESC"],
      ],
      limit: trendingPoolSize,
    }),
    followedIds.length
      ? readRows({
          label: "reels.findAll(candidate_social)",
          extraWhere: { userId: { [Op.in]: followedIds } },
          order: [["createdAt", "DESC"], ["id", "DESC"]],
          limit: socialPoolSize,
        })
      : Promise.resolve([] as any[]),
    readRows({
      label: "reels.findAll(candidate_exploration)",
      extraWhere: excludedCreatorIds.length
        ? { userId: { [Op.notIn]: excludedCreatorIds } }
        : undefined,
      order: [["createdAt", "DESC"], ["id", "DESC"]],
      limit: explorationPoolSize,
    }),
  ]);

  const unique = new Map<number, any>();
  [...socialRows, ...recentRows, ...trendingRows, ...explorationRows].forEach((row: any) => {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) return;
    if (!unique.has(id)) unique.set(id, row);
  });

  return Array.from(unique.values());
};

const getOrbitQualityGateFailureReason = (row: any): string | null => {
  if (!row) return "null_row";
  const reelId = Number(row?.id);
  const creatorId = Number(row?.user?.id ?? row?.userId);
  if (!Number.isFinite(reelId) || reelId <= 0) return "invalid_reel_id";
  if (!Number.isFinite(creatorId) || creatorId <= 0) return "invalid_creator_id";

  const status = String(row?.status ?? "").trim().toLowerCase();
  if (status && status !== "ready") return "status_not_ready";

  const playback = buildPlaybackState(row);
  if (!playback.isReady) return "playback_not_ready";

  const mediaUrl = String(
    playback.streamUrl ??
      playback.imageUrl ??
      row?.stream_url ??
      row?.thumbnail_url ??
      ""
  ).trim();
  if (!mediaUrl) return "missing_media_url";

  return null;
};

const orbitPassesQualityGate = (row: any) => {
  return getOrbitQualityGateFailureReason(row) === null;
};

const buildOrbitCandidate = ({
  row,
  viewerContext,
  sessionState,
  recentlyViewedSet,
}: {
  row: any;
  viewerContext: OrbitViewerContext;
  sessionState: OrbitSessionState;
  recentlyViewedSet: Set<number>;
}): OrbitCandidate | null => {
  if (!orbitPassesQualityGate(row)) return null;

  const id = Number(row?.id);
  const creatorId = Number(row?.user?.id ?? row?.userId);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(creatorId) || creatorId <= 0) {
    return null;
  }

  const createdAt = toValidDate(row?.createdAt);
  const ageHours = createdAt
    ? Math.max(0, (Date.now() - createdAt.getTime()) / (60 * 60 * 1000))
    : 96;

  const likes = toEngagementCounter(row?.likes_count);
  const comments = toEngagementCounter(row?.comments_count);
  const shares = toEngagementCounter(row?.shares_count);
  const saves = toEngagementCounter(row?.saves_count);
  const views = toEngagementCounter(row?.views_count);

  const topicKeys = extractReelTopicKeys(row);
  const primaryTopic = topicKeys[0] ?? "general";
  const interestScore = computeLabelOverlap(viewerContext.interestLabels, topicKeys);

  const freshnessScore = clamp01(Math.exp(-ageHours / 30));
  const watchProxyScore = clamp01(
    Math.log1p(views + likes * 2 + comments * 3 + saves * 4 + shares * 5) / 10
  );
  const saveShareScore = clamp01(Math.log1p(saves * 2 + shares * 3) / 8);
  const socialScore = viewerContext.followedCreatorIds.has(creatorId) ? 1 : 0;

  const engagementVolume = likes * 1.2 + comments * 2.2 + shares * 3.2 + saves * 3 + views * 0.15;
  const trendingScore = clamp01(
    (Math.log1p(engagementVolume) / 9) * (0.6 + 0.4 * freshnessScore)
  );
  const qualityScore = clamp01(
    (Math.log1p(likes + comments * 2 + shares * 3 + saves * 2 + 1) / 8) *
      (0.75 + 0.25 * freshnessScore)
  );

  const creatorExposure = Number(sessionState.creatorImpressions[String(creatorId)] ?? 0);
  const noveltyScore =
    creatorExposure <= 0 ? 1 : creatorExposure === 1 ? 0.65 : creatorExposure === 2 ? 0.35 : 0.15;
  const explorationScore =
    socialScore > 0 ? 0 : clamp01(noveltyScore * 0.7 + (ageHours <= 72 ? 0.3 : 0.1));

  const seenInSession = sessionState.seenReelIds.includes(id);
  const recentlyViewed = recentlyViewedSet.has(id);
  const recentCreatorPenalty = sessionState.recentCreatorIds.includes(creatorId) ? 0.22 : 0;
  const recentTopicPenalty = sessionState.recentPrimaryTopics.includes(primaryTopic) ? 0.08 : 0;
  const fatiguePenalty = seenInSession ? 0.6 : recentlyViewed ? 0.35 : 0;
  const lowQualityPenalty =
    ageHours > 72 && engagementVolume < 6 && watchProxyScore < 0.2 ? 0.18 : 0;

  const weightedBase =
    0.35 * watchProxyScore +
    0.2 * interestScore +
    0.15 * freshnessScore +
    0.1 * saveShareScore +
    0.1 * socialScore +
    0.1 * explorationScore;

  const finalScore =
    weightedBase +
    0.08 * qualityScore +
    0.05 * noveltyScore +
    0.03 * trendingScore -
    recentCreatorPenalty -
    recentTopicPenalty -
    fatiguePenalty -
    lowQualityPenalty;

  const viralScore = clamp01(0.55 * trendingScore + 0.45 * saveShareScore + (shares >= 20 ? 0.15 : 0));

  let bucket: OrbitBucket = "exploration";
  if (socialScore > 0) {
    bucket = "social";
  } else if (interestScore >= 0.2) {
    bucket = "affinity";
  } else if (trendingScore >= 0.45) {
    bucket = "trending";
  }

  return {
    row,
    id,
    creatorId,
    primaryTopic,
    topicKeys,
    bucket,
    trendingScore,
    viralScore,
    seenInSession,
    recentlyViewed,
    qualityPassed: true,
    finalScore,
    scoreBreakdown: {
      watchProxy: watchProxyScore,
      interest: interestScore,
      freshness: freshnessScore,
      saveShare: saveShareScore,
      social: socialScore,
      exploration: explorationScore,
      quality: qualityScore,
      novelty: noveltyScore,
      trending: trendingScore,
      weightedBase,
      creatorPenalty: recentCreatorPenalty,
      topicPenalty: recentTopicPenalty,
      fatiguePenalty,
      lowQualityPenalty,
    },
  };
};

const ORBIT_BUCKETS: OrbitBucket[] = [
  "affinity",
  "trending",
  "social",
  "exploration",
];

const buildOrbitBucketTargets = ({
  desiredCount,
  availableByBucket,
  suggested,
  hasViewer,
}: {
  desiredCount: number;
  availableByBucket: Record<OrbitBucket, number>;
  suggested: boolean;
  hasViewer: boolean;
}) => {
  const weights: Record<OrbitBucket, number> = suggested
    ? {
        affinity: 0.35,
        trending: 0.3,
        social: 0.2,
        exploration: 0.15,
      }
    : {
        affinity: 0.4,
        trending: 0.25,
        social: 0.2,
        exploration: 0.15,
      };

  if (!hasViewer) {
    weights.affinity = 0.2;
    weights.social = 0;
    weights.trending = 0.5;
    weights.exploration = 0.3;
  }

  if (!availableByBucket.social) {
    weights.trending += weights.social * 0.6;
    weights.exploration += weights.social * 0.4;
    weights.social = 0;
  }

  if (!availableByBucket.affinity) {
    weights.trending += weights.affinity * 0.6;
    weights.exploration += weights.affinity * 0.4;
    weights.affinity = 0;
  }

  const activeBuckets = ORBIT_BUCKETS.filter(
    (bucket) => availableByBucket[bucket] > 0 && weights[bucket] > 0
  );
  if (!activeBuckets.length) {
    return {
      affinity: 0,
      trending: 0,
      social: 0,
      exploration: 0,
    };
  }

  const weightSum = activeBuckets.reduce(
    (sum, bucket) => sum + weights[bucket],
    0
  );
  const targets: Record<OrbitBucket, number> = {
    affinity: 0,
    trending: 0,
    social: 0,
    exploration: 0,
  };

  let assigned = 0;
  activeBuckets.forEach((bucket, index) => {
    const available = availableByBucket[bucket];
    if (index === activeBuckets.length - 1) {
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
    for (const bucket of activeBuckets) {
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

const selectOrbitCandidates = ({
  scoredCandidates,
  desiredCount,
  bucketTargets,
  sessionState,
}: {
  scoredCandidates: OrbitCandidate[];
  desiredCount: number;
  bucketTargets: Record<OrbitBucket, number>;
  sessionState: OrbitSessionState;
}) => {
  const selected: OrbitCandidate[] = [];
  const selectedIds = new Set<number>();
  const recentCreatorWindow: number[] = [];
  const bucketCounts: Record<OrbitBucket, number> = {
    affinity: 0,
    trending: 0,
    social: 0,
    exploration: 0,
  };
  const creatorImpressions = sessionState.creatorImpressions ?? {};

  let currentTopic = "";
  let topicStreak = 0;

  const hasUnfilledTarget = () =>
    ORBIT_BUCKETS.some((bucket) => bucketCounts[bucket] < (bucketTargets[bucket] ?? 0));

  const registerSelection = (candidate: OrbitCandidate) => {
    selected.push(candidate);
    selectedIds.add(candidate.id);
    bucketCounts[candidate.bucket] += 1;
    pushUniqueLimited(recentCreatorWindow, candidate.creatorId, ORBIT_CREATOR_COOLDOWN);

    if (candidate.primaryTopic && candidate.primaryTopic === currentTopic) {
      topicStreak += 1;
    } else {
      currentTopic = candidate.primaryTopic;
      topicStreak = candidate.primaryTopic ? 1 : 0;
    }
  };

  const hasAlternativeCreatorCandidate = (creatorId: number) => {
    return scoredCandidates.some((candidate) => {
      if (!candidate.qualityPassed) return false;
      if (selectedIds.has(candidate.id)) return false;
      return candidate.creatorId !== creatorId;
    });
  };

  const canSelect = (candidate: OrbitCandidate, phase: number): string | null => {
    if (selectedIds.has(candidate.id)) return "already_selected";
    if (!candidate.qualityPassed) return "quality_gate_failed";

    const strictBucket = phase === 0;
    const strictDiversity = phase <= 1;
    const strictFatigue = phase <= 1;

    if (strictFatigue && candidate.seenInSession) return "seen_in_session";
    if (strictFatigue && candidate.recentlyViewed && candidate.viralScore < 0.82) {
      return "recently_viewed";
    }
    if (phase === 0 && candidate.finalScore < -0.05) return "low_score_floor";

    const lastSelected = selected[selected.length - 1];
    if (
      lastSelected &&
      lastSelected.creatorId === candidate.creatorId &&
      hasAlternativeCreatorCandidate(candidate.creatorId)
    ) {
      return "same_creator_consecutive_blocked";
    }

    if (strictDiversity && recentCreatorWindow.includes(candidate.creatorId)) {
      return "creator_cooldown";
    }
    if (
      strictDiversity &&
      topicStreak >= ORBIT_MAX_TOPIC_STREAK &&
      candidate.primaryTopic &&
      candidate.primaryTopic === currentTopic
    ) {
      return "topic_streak_limit";
    }

    const needsNewCreatorSlot =
      selected.length > 0 && (selected.length + 1) % ORBIT_NEW_CREATOR_EVERY === 0;
    if (phase === 0 && needsNewCreatorSlot) {
      const impressionCount = Number(creatorImpressions[String(candidate.creatorId)] ?? 0);
      if (impressionCount > 0) return "new_creator_slot_required";
    }

    if (strictBucket) {
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
      if (candidate.seenInSession && candidate.viralScore < 0.9) {
        candidate.excludedReason = candidate.excludedReason ?? "seen_in_session_low_viral";
        continue;
      }
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

export const __selectOrbitCandidatesForTest = selectOrbitCandidates;

const applyOrbitTopKShuffle = (
  candidates: OrbitCandidate[],
  seedRaw: any
): OrbitCandidate[] => {
  if (!Array.isArray(candidates) || candidates.length <= 2) return candidates;
  const seed = normalizeSessionToken(seedRaw) || "orbit-feed";
  const windowSize = Math.min(ORBIT_TOPK_SHUFFLE_WINDOW, candidates.length);

  const head = candidates
    .slice(0, windowSize)
    .map((candidate) => {
      const hash = hashString(`${seed}:${candidate.id}`);
      const noise = (hash % 1000) / 1000 - 0.5;
      return {
        candidate,
        rank: candidate.finalScore + noise * 0.035,
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.candidate);

  return [...head, ...candidates.slice(windowSize)];
};

const selectOrbitPageCandidates = ({
  shuffledCandidates,
  size,
  start,
  end,
  sessionState,
}: {
  shuffledCandidates: OrbitCandidate[];
  size: number;
  start: number;
  end: number;
  sessionState: OrbitSessionState;
}) => {
  if (!Array.isArray(shuffledCandidates) || !shuffledCandidates.length || size <= 0) {
    return [] as OrbitCandidate[];
  }

  const seenBeforeRequest = new Set<number>(
    (sessionState?.seenReelIds ?? [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  const unseenFirst = shuffledCandidates.filter(
    (candidate) => !seenBeforeRequest.has(candidate.id)
  );

  if (unseenFirst.length >= size) {
    return unseenFirst.slice(0, size);
  }

  if (start > 0) {
    const legacyPageSlice = shuffledCandidates.slice(start, end);
    if (legacyPageSlice.length >= size) {
      return legacyPageSlice.slice(0, size);
    }
  }

  const selected = [...unseenFirst];
  const selectedIds = new Set<number>(selected.map((candidate) => candidate.id));

  for (const candidate of shuffledCandidates) {
    if (selectedIds.has(candidate.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
    if (selected.length >= size) break;
  }

  return selected.slice(0, size);
};

const logOrbitFindDebug = ({
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
  bucketTargets: Record<OrbitBucket, number>;
  scoredCandidates: OrbitCandidate[];
  selectedCandidates: OrbitCandidate[];
  pageCandidates: OrbitCandidate[];
}) => {
  if (!shouldLogFindDebug()) return;

  const maxItems = getFindDebugMaxItems();
  const selectedIds = new Set<number>(selectedCandidates.map((candidate) => candidate.id));
  const pageIds = new Set<number>(pageCandidates.map((candidate) => candidate.id));

  console.log(
    `[find/orbit] summary ${JSON.stringify({
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
      `[find/orbit/item] ${JSON.stringify({
        reel_id: item.id,
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
      `[find/orbit/item] ${JSON.stringify({
        rank: index + 1,
        reel_id: candidate.id,
        creator_id: candidate.creatorId,
        bucket: candidate.bucket,
        state,
        score_final: round3(candidate.finalScore),
        penalties_applied: {
          creator: round3(candidate.scoreBreakdown.creatorPenalty),
          topic: round3(candidate.scoreBreakdown.topicPenalty),
          fatigue: round3(candidate.scoreBreakdown.fatiguePenalty),
          low_quality: round3(candidate.scoreBreakdown.lowQualityPenalty),
        },
        excluded_reason: excludedReason,
      })}`
    );
  });
};

const logOrbitFindPerf = ({
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
  profiler: OrbitFindProfiler;
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
    `[find/orbit/perf] ${JSON.stringify({
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

const recountLikes = async (reelId: number) => {
  const total = await ReelLike.count({ where: { reelId } });
  await Reel.update({ likes_count: total }, { where: { id: reelId } });
  return total;
};

const recountSaves = async (reelId: number) => {
  const total = await ReelSave.count({ where: { reelId } });
  await Reel.update({ saves_count: total }, { where: { id: reelId } });
  return total;
};

const recountComments = async (reelId: number) => {
  const total = await ReelComment.count({ where: { reelId, is_delete: false } });
  await Reel.update({ comments_count: total }, { where: { id: reelId } });
  return total;
};

export const createReel = async (body: any) => {
  return Reel.create(body);
};

export const listFeed = async (
  pageRaw: any,
  sizeRaw: any,
  viewerIdRaw: any,
  suggested = false,
  options: OrbitListFeedOptions & { summary?: boolean } = {}
) => {
  const profiler = createOrbitFindProfiler();
  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 20);
  const viewerId = normalizeUserId(viewerIdRaw);
  const sessionToken = normalizeSessionToken(options?.sessionKey);
  const sessionMemoryKey = buildOrbitSessionMemoryKey(viewerId, sessionToken);
  const sessionLoadStartedAtMs = nowMs();
  const {
    state: sessionState,
    backend: sessionLoadBackend,
  } = await getOrbitSessionState(sessionMemoryKey);
  profiler.sessionLoadMs = nowMs() - sessionLoadStartedAtMs;
  profiler.sessionLoadBackend = sessionLoadBackend;
  const start = page * size;
  const end = start + size;
  const desiredCount = Math.max(end, size);

  const where = buildFeedWhere(viewerId);
  const [totalCount, viewerContext, recentlyViewedSet] = await Promise.all([
    withOrbitDbProfile(profiler, "reels.count(feed_total)", () =>
      Reel.count({
        where,
        replacements: { meId: viewerId ?? -1 },
        distinct: true,
        col: "id",
      } as any)
    ),
    loadOrbitViewerContext(viewerId, profiler),
    loadRecentlyViewedOrbitIds(viewerId, sessionToken, profiler),
  ]);

  const candidateRows = await fetchOrbitCandidatePool({
    where,
    viewerId,
    size,
    page,
    followedCreatorIds: viewerContext.followedCreatorIds,
    profiler,
    summary: Boolean(options.summary),
  });

  const rerankStartedAtMs = nowMs();
  const qualityRejected: Array<{ id: number; creatorId: number; reason: string }> = [];
  const scoredCandidates: OrbitCandidate[] = [];
  candidateRows.forEach((row) => {
    const candidate = buildOrbitCandidate({
      row,
      viewerContext,
      sessionState,
      recentlyViewedSet,
    });
    if (candidate) {
      scoredCandidates.push(candidate);
      return;
    }

    const reason = getOrbitQualityGateFailureReason(row) ?? "candidate_not_built";
    qualityRejected.push({
      id: Number(row?.id ?? 0) || 0,
      creatorId: Number(row?.user?.id ?? row?.userId ?? 0) || 0,
      reason,
    });
  });
  scoredCandidates.sort((a, b) => b.finalScore - a.finalScore);

  const availableByBucket: Record<OrbitBucket, number> = {
    affinity: 0,
    trending: 0,
    social: 0,
    exploration: 0,
  };
  scoredCandidates.forEach((candidate) => {
    availableByBucket[candidate.bucket] += 1;
  });

  const bucketTargets = buildOrbitBucketTargets({
    desiredCount,
    availableByBucket,
    suggested,
    hasViewer: Boolean(viewerId),
  });

  const selectedCandidates = selectOrbitCandidates({
    scoredCandidates,
    desiredCount,
    bucketTargets,
    sessionState,
  });
  const shuffledCandidates = applyOrbitTopKShuffle(selectedCandidates, sessionToken || viewerId);
  const pageCandidates = selectOrbitPageCandidates({
    shuffledCandidates,
    size,
    start,
    end,
    sessionState,
  });
  profiler.rerankMs = nowMs() - rerankStartedAtMs;
  const pageRows = pageCandidates.map((candidate) => candidate.row);

  if (!options.summary) {
    await attachInteractionFlags(viewerId, pageRows, profiler);
    await attachUserOrbitRing(pageRows, profiler);
  }
  const sessionSaveStartedAtMs = nowMs();
  const sessionSaveBackend = await updateOrbitSessionState(
    sessionMemoryKey,
    sessionState,
    pageRows
  );
  profiler.sessionSaveMs = nowMs() - sessionSaveStartedAtMs;
  profiler.sessionSaveBackend = sessionSaveBackend;
  logOrbitFindDebug({
    viewerId,
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
  logOrbitFindPerf({
    viewerId,
    page,
    size,
    totalCount: Number(totalCount || 0),
    candidatePoolSize: candidateRows.length,
    profiler,
  });

  return {
    page,
    size,
    count: Number(totalCount || 0),
    rows: options.summary ? pageRows : mapWithFlagAliases(pageRows),
  };
};

export const listMine = async (userIdRaw: any, pageRaw: any, sizeRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  if (!userId) {
    return { page: 0, size: 0, count: 0, rows: [] };
  }

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);

  const reels = await Reel.findAndCountAll({
    where: { is_delete: false, userId },
    include: [reelUserInclude],
    order: [["createdAt", "DESC"]],
    distinct: true,
    limit: size,
    offset: page * size,
  });

  await attachInteractionFlags(userId, reels.rows);
  await attachUserOrbitRing(reels.rows);

  return {
    page,
    size,
    count: Number(reels.count || 0),
    rows: mapWithFlagAliases(reels.rows),
  };
};

export const listByUser = async (
  targetUserIdRaw: any,
  pageRaw: any,
  sizeRaw: any,
  viewerIdRaw: any
) => {
  const targetUserId = normalizeUserId(targetUserIdRaw);
  if (!targetUserId) {
    return { page: 0, size: 0, count: 0, rows: [], notFound: true };
  }

  const viewerId = normalizeUserId(viewerIdRaw);
  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);

  const owner = await User.findOne({
    where: {
      id: targetUserId,
      disabled: false,
      is_deleted: false,
    },
    attributes: ["id"],
  });
  if (!owner) {
    return { page, size, count: 0, rows: [], notFound: true };
  }

  let canSeeFollowersOnly = false;
  if (viewerId && viewerId !== targetUserId) {
    const relation = await Follower.findOne({
      where: { userId: targetUserId, followerId: viewerId },
      attributes: ["id"],
    });
    canSeeFollowersOnly = Boolean(relation);
  }

  const baseWhere: any = {
    is_delete: false,
    userId: targetUserId,
  };

  if (viewerId !== targetUserId) {
    baseWhere.status = 'ready';
    baseWhere.visibility = canSeeFollowersOnly
      ? { [Op.in]: ["public", "followers"] }
      : "public";
  }

  const blockedWhere = whereNotBlockedProfileExists(viewerId, targetUserId);
  const blockedAnd = blockedWhere?.[Op.and];
  if (Array.isArray(blockedAnd) && blockedAnd.length) {
    baseWhere[Op.and] = blockedAnd;
  }

  const reels = await Reel.findAndCountAll({
    where: baseWhere,
    include: [
      {
        ...reelUserInclude,
        required: true,
        where: {
          id: targetUserId,
          disabled: false,
          is_deleted: false,
        },
      },
    ],
    replacements: { meId: viewerId ?? -1, targetId: targetUserId },
    order: [["createdAt", "DESC"]],
    distinct: true,
    limit: size,
    offset: page * size,
  });

  await attachInteractionFlags(viewerId, reels.rows);
  await attachUserOrbitRing(reels.rows);

  return {
    page,
    size,
    count: Number(reels.count || 0),
    rows: mapWithFlagAliases(reels.rows),
    notFound: false,
  };
};

export const getById = async (idRaw: any, viewerIdRaw: any) => {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return null;

  const viewerId = normalizeUserId(viewerIdRaw);

  let reel = null;
  if (viewerId) {
    reel = await Reel.findOne({
      where: {
        id,
        is_delete: false,
        userId: viewerId,
      },
      include: [reelUserInclude],
      replacements: { meId: viewerId },
    });
  }

  if (!reel) {
    const feedWhere = buildFeedWhere(viewerId);
    reel = await Reel.findOne({
      where: {
        id,
        ...(feedWhere || {}),
      },
      include: [reelUserInclude],
      replacements: { meId: viewerId ?? -1 },
    });
  }

  if (!reel) return null;
  await attachInteractionFlags(viewerId, [reel]);
  await attachUserOrbitRing([reel]);
  return withFlagAliases(reel);
};

export const deleteReel = async (idRaw: any, userIdRaw: any) => {
  const id = Number(idRaw);
  const userId = normalizeUserId(userIdRaw);
  if (!Number.isFinite(id) || id <= 0 || !userId) {
    return { notFound: true, forbidden: false };
  }

  const reel = await Reel.findByPk(id);
  if (!reel || reel.is_delete) return { notFound: true, forbidden: false };
  if (Number(reel.userId) !== userId) return { notFound: false, forbidden: true };

  await reel.update({ is_delete: true, deleted_date: new Date(new Date().toUTCString()) });
  return { notFound: false, forbidden: false, reel };
};

export const reportReel = async ({
  reelIdRaw,
  reporterIdRaw,
  reason,
  details,
}: {
  reelIdRaw: any;
  reporterIdRaw: any;
  reason: string;
  details?: string | null;
}) => {
  const reelId = Number(reelIdRaw);
  const reporterId = Number(reporterIdRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true };
  }
  if (!Number.isFinite(reporterId) || reporterId <= 0) {
    return { invalidReporter: true };
  }

  const sequelize = (Reel as any).sequelize;
  const normalizedDetails = String(details ?? "").trim().slice(0, 4000) || null;

  return sequelize.transaction(async (transaction: any) => {
    const reel = await Reel.findOne({
      where: { id: reelId, is_delete: false },
      attributes: ["id", "userId", "is_delete"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!reel) {
      return { notFound: true };
    }

    const ownerId = Number((reel as any)?.userId ?? 0);
    if (ownerId > 0 && ownerId === reporterId) {
      return { selfReport: true };
    }

    const existing = await ReelReport.findOne({
      where: { reelId, reporterId },
      attributes: ["id"],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    let alreadyReported = false;
    if (!existing) {
      try {
        await ReelReport.create(
          {
            reelId,
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

    const reportsCount = await ReelReport.count({
      where: { reelId },
      distinct: true,
      col: "reporterId",
      transaction,
    });

    const shouldAutoDelete =
      Number(reportsCount) >= REEL_REPORT_AUTO_DELETE_THRESHOLD &&
      !Boolean((reel as any)?.is_delete);

    let autoDeleted = false;
    if (shouldAutoDelete) {
      await Reel.update(
        {
          is_delete: true,
          deleted_date: new Date(new Date().toUTCString()),
        },
        {
          where: { id: reelId },
          transaction,
        }
      );
      autoDeleted = true;
    }

    return {
      notFound: false,
      invalidReporter: false,
      selfReport: false,
      alreadyReported,
      reportsCount: Number(reportsCount) || 0,
      threshold: REEL_REPORT_AUTO_DELETE_THRESHOLD,
      autoDeleted,
      reelId,
      ownerId,
    };
  });
};

export const toggleStar = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, starred: false, likes_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, starred: false, likes_count: 0 };

  const existing = await ReelLike.findOne({ where: { userId, reelId } });
  let starred = false;
  if (existing) {
    await existing.destroy();
    starred = false;
  } else {
    await ReelLike.create({ userId, reelId });
    starred = true;
  }

  const likes_count = await recountLikes(reelId);
  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);
  await attachUserOrbitRing(updatedReel ? [updatedReel] : []);

  return { notFound: false, starred, likes_count, reel: withFlagAliases(updatedReel) };
};

export const saveReel = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, saved: false, created: false, saves_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, saved: false, created: false, saves_count: 0 };

  const [row, created] = await ReelSave.findOrCreate({
    where: { userId, reelId },
    defaults: { userId, reelId },
  });

  const saves_count = await recountSaves(reelId);
  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);
  await attachUserOrbitRing(updatedReel ? [updatedReel] : []);

  return {
    notFound: false,
    saved: true,
    created,
    saves_count,
    row,
    reel: withFlagAliases(updatedReel),
  };
};

export const unsaveReel = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, saved: false, removed: false, saves_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, saved: false, removed: false, saves_count: 0 };

  const deleted = await ReelSave.destroy({ where: { userId, reelId } });
  const saves_count = await recountSaves(reelId);

  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);
  await attachUserOrbitRing(updatedReel ? [updatedReel] : []);

  return {
    notFound: false,
    saved: false,
    removed: deleted > 0,
    saves_count,
    reel: withFlagAliases(updatedReel),
  };
};

export const listSaved = async (userIdRaw: any, pageRaw: any, sizeRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  if (!userId) {
    return { page: 0, size: 0, count: 0, rows: [] };
  }

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);

  const saves = await ReelSave.findAndCountAll({
    where: { userId },
    include: [
      {
        model: Reel,
        as: "reel",
        required: true,
        where: { is_delete: false, status: 'ready' },
        include: [reelUserInclude],
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: size,
    offset: page * size,
    distinct: true,
  });

  const rows = saves.rows
    .map((row: any) => row.reel)
    .filter((row: any) => !!row);

  await attachInteractionFlags(userId, rows);
  await attachUserOrbitRing(rows);
  rows.forEach((row: any) => setInteractionFlags(row, { isStarred: Boolean((row as any)?.is_starred), isSaved: true }));

  return {
    page,
    size,
    count: Number(saves.count || 0),
    rows: mapWithFlagAliases(rows),
  };
};

export const recordView = async (
  idRaw: any,
  userIdRaw: any,
  sessionKeyRaw: any
) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { found: false, counted: false, reel: null };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { found: false, counted: false, reel: null };

  const userId = normalizeUserId(userIdRaw);
  const sessionKey = String(sessionKeyRaw ?? "").trim();
  const viewedDate = new Date().toISOString().slice(0, 10);

  let created = false;

  if (userId) {
    const [, wasCreated] = await ReelView.findOrCreate({
      where: { reelId, userId, viewed_date: viewedDate },
      defaults: {
        reelId,
        userId,
        session_key: sessionKey || null,
        viewed_date: viewedDate,
      },
    });
    created = wasCreated;
  } else {
    if (!sessionKey) {
      const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
      await attachInteractionFlags(userId, updated ? [updated] : []);
      await attachUserOrbitRing(updated ? [updated] : []);
      return { found: true, counted: false, reel: withFlagAliases(updated) };
    }

    const [, wasCreated] = await ReelView.findOrCreate({
      where: { reelId, session_key: sessionKey, viewed_date: viewedDate },
      defaults: {
        reelId,
        userId: null,
        session_key: sessionKey,
        viewed_date: viewedDate,
      },
    });
    created = wasCreated;
  }

  if (created) {
    await Reel.increment({ views_count: 1 }, { where: { id: reelId } });
  }

  const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updated ? [updated] : []);
  await attachUserOrbitRing(updated ? [updated] : []);
  return { found: true, counted: created, reel: withFlagAliases(updated) };
};

export const shareReel = async (idRaw: any, viewerIdRaw: any) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { found: false, reel: null };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { found: false, reel: null };

  await Reel.increment({ shares_count: 1 }, { where: { id: reelId } });
  const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(viewerIdRaw, updated ? [updated] : []);
  await attachUserOrbitRing(updated ? [updated] : []);

  return { found: true, reel: withFlagAliases(updated) };
};

export const addComment = async (idRaw: any, userIdRaw: any, body: any) => {
  const reelId = Number(idRaw);
  const userId = normalizeUserId(userIdRaw);
  if (!Number.isFinite(reelId) || reelId <= 0 || !userId) {
    return { notFound: true, comment: null, comments_count: 0, reelUserId: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, comment: null, comments_count: 0, reelUserId: 0 };

  const payload = {
    reelId,
    userId,
    comment: body?.comment ?? null,
    media_url: body?.media_url ?? null,
    is_delete: false,
  };

  const comment = await ReelComment.create(payload);
  const comments_count = await recountComments(reelId);

  const hydrated = await ReelComment.findByPk(comment.id, {
    include: [
      {
        model: User,
        as: "comment_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
    ],
  });

  return {
    notFound: false,
    comment: hydrated ?? comment,
    comments_count,
    reelUserId: Number((reel as any)?.userId ?? 0),
  };
};

export const listComments = async (idRaw: any, pageRaw: any, sizeRaw: any) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, page: 0, size: 0, count: 0, rows: [] };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, page: 0, size: 0, count: 0, rows: [] };

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 20, 50);

  const comments = await ReelComment.findAndCountAll({
    where: { reelId, is_delete: false },
    include: [
      {
        model: User,
        as: "comment_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: size,
    offset: page * size,
    distinct: true,
  });

  return {
    notFound: false,
    page,
    size,
    count: Number(comments.count || 0),
    rows: comments.rows,
  };
};

export const deleteComment = async (commentIdRaw: any, userIdRaw: any) => {
  const commentId = Number(commentIdRaw);
  const userId = normalizeUserId(userIdRaw);

  if (!Number.isFinite(commentId) || commentId <= 0 || !userId) {
    return { notFound: true, forbidden: false, removed: false, comments_count: 0 };
  }

  const comment = await ReelComment.findByPk(commentId);
  if (!comment) {
    return { notFound: true, forbidden: false, removed: false, comments_count: 0 };
  }

  if (comment.is_delete) {
    const comments_count = await ReelComment.count({
      where: { reelId: comment.reelId, is_delete: false },
    });
    return {
      notFound: false,
      forbidden: false,
      removed: false,
      reelId: comment.reelId,
      comments_count,
    };
  }

  const reel = await Reel.findByPk(comment.reelId, { attributes: ["id", "userId"] });
  const isOwner = Number(comment.userId) === userId;
  const isReelOwner = Number(reel?.userId) === userId;

  if (!isOwner && !isReelOwner) {
    return { notFound: false, forbidden: true, removed: false, comments_count: 0 };
  }

  await comment.update({
    is_delete: true,
    deleted_date: new Date(new Date().toUTCString()),
  });

  const comments_count = await recountComments(Number(comment.reelId));

  return {
    notFound: false,
    forbidden: false,
    removed: true,
    reelId: Number(comment.reelId),
    comments_count,
  };
};

export const getDownloadUrl = (reel: any) => {
  const allowDownload = Boolean(reel?.allow_download);
  if (!allowDownload) return null;

  const mediaType = normalizeMediaType(reel);
  const metadata = reel?.metadata && typeof reel.metadata === 'object' ? reel.metadata : {};
  const videoUid = String(reel?.video_uid ?? "").trim();
  const customDownload = String(reel?.download_url ?? "").trim();
  if (customDownload) return customDownload;
  if (mediaType === 'image') {
    const imageUrl = String(metadata?.image_url ?? metadata?.imageUrl ?? reel?.stream_url ?? '').trim();
    return imageUrl || null;
  }
  if (videoUid) {
    return `/api/v1/media/video/download?uid=${encodeURIComponent(videoUid)}`;
  }
  const stream = String(reel?.stream_url ?? "").trim();
  return stream || null;
};
