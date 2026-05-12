import { AppLocale } from "./localization/locale";
import { formatRelativeTime } from "./localization/relative_time";
import { createHmac } from "crypto";
import {
  buildApplicantsStatus,
  enrichServiceApplicantsStatus,
  normalizeApplicantsStatus,
  resolveApplicantsCount,
} from "./applicants_status";
import { buildServiceRoutingFields } from "./service_client_bucket";

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? null;

const toText = (value: any) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const toBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const truncateText = (value: any, max = 120) => {
  const text = toText(value);
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
};

const normalizeHashtagToken = (value: any): string | null => {
  const token = String(value ?? "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
  if (!token) return null;
  return token;
};

const toHashtagSummary = (value: any) => {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: Array<{ tag: string; display: string }> = [];

  items.forEach((item: any) => {
    const tag = normalizeHashtagToken(item?.tag ?? item?.display ?? item);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    out.push({ tag, display: `#${tag}` });
  });

  return out;
};

const toIsoDate = (value: any) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const MEDIA_ACCESS_TOKEN_QUERY_KEY = "sat";
const MEDIA_ACCESS_TOKEN_TTL_SECONDS = Math.max(
  30,
  Number(process.env.MEDIA_ACCESS_TOKEN_TTL_SECONDS ?? 10 * 60) || 10 * 60
);

const getMediaAccessSigningSecret = () =>
  String(
    process.env.MEDIA_ACCESS_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      process.env.SECRETORPRIVATEKEY ??
      ""
  ).trim();

const toBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const normalizeMediaObjectKey = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = decodeURIComponent(String(value).trim());
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return null;
  return normalized;
};

const buildMediaAccessToken = (resourceKey: string): string | null => {
  const secret = getMediaAccessSigningSecret();
  if (!secret) return null;

  const key = String(resourceKey ?? "").trim();
  if (!key) return null;

  const exp = Math.floor(Date.now() / 1000) + MEDIA_ACCESS_TOKEN_TTL_SECONDS;
  const payload = `audio:${key}:${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${exp}.${toBase64Url(signature)}`;
};

const refreshVoiceMediaUrl = (
  messageTypeRaw: string | null,
  rawUrl: string | null
): string | null => {
  const sourceUrl = toText(rawUrl);
  if (!sourceUrl) return sourceUrl;

  const messageType = String(messageTypeRaw ?? "").trim().toLowerCase();
  if (messageType !== "voice") return sourceUrl;

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, "http://local");
  } catch {
    return sourceUrl;
  }

  if (String(parsed.pathname ?? "").trim().toLowerCase() !== "/api/v1/media/audio/play") {
    return sourceUrl;
  }

  const key = normalizeMediaObjectKey(parsed.searchParams.get("key"));
  if (!key) return sourceUrl;

  const token = buildMediaAccessToken(key);
  if (!token) return sourceUrl;

  parsed.searchParams.set(MEDIA_ACCESS_TOKEN_QUERY_KEY, token);
  const query = parsed.searchParams.toString();
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
};

const toCount = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const pickFirstBool = (...values: any[]): boolean | null => {
  for (const value of values) {
    const normalized = toBoolOrNull(value);
    if (normalized !== null) return normalized;
  }
  return null;
};

const toPlaybackType = (urlRaw: any): string | null => {
  const url = toText(urlRaw);
  if (!url) return null;
  return String(url).toLowerCase().includes(".m3u8") ? "hls" : "url";
};

const getRelationshipFromLookup = (
  relationshipLookup: any,
  userId: number | null
) => {
  if (!relationshipLookup || !userId) return null;

  if (relationshipLookup instanceof Map) {
    return relationshipLookup.get(userId) ?? null;
  }

  if (typeof relationshipLookup === "object") {
    return relationshipLookup[userId] ?? relationshipLookup[String(userId)] ?? null;
  }

  return null;
};

const getRelationshipFromFollowGraph = (user: any, viewerIdRaw: any) => {
  const viewerId = Number(viewerIdRaw ?? 0);
  if (!Number.isFinite(viewerId) || viewerId <= 0) {
    return { isFollowing: null, isFollowedBy: null };
  }

  const followers = Array.isArray(user?.followers) ? user.followers : [];
  const followings = Array.isArray(user?.followings) ? user.followings : [];

  const viewerFollowsUser = followers.some(
    (row: any) => Number(row?.followerId ?? row?.follower_id) === viewerId
  );
  const userFollowsViewer = followings.some(
    (row: any) => Number(row?.userId ?? row?.user_id) === viewerId
  );

  return {
    isFollowing: viewerFollowsUser,
    isFollowedBy: userFollowsViewer,
  };
};

const resolveRelationshipFlags = (
  user: any,
  viewerIdRaw: any,
  relationshipRaw?: any
) => {
  const relationship = relationshipRaw ?? user?.relationship ?? null;
  let isFollowing = pickFirstBool(
    relationship?.isFollowing,
    relationship?.is_following,
    user?.isFollowing,
    user?.is_following,
    user?.viewerFollowsUser,
    user?.viewer_follows_user
  );
  let isFollowedBy = pickFirstBool(
    relationship?.isFollowedBy,
    relationship?.is_followed_by,
    user?.isFollowedBy,
    user?.is_followed_by,
    user?.userFollowsViewer,
    user?.user_follows_viewer
  );

  if (isFollowing === null || isFollowedBy === null) {
    const fromGraph = getRelationshipFromFollowGraph(user, viewerIdRaw);
    if (isFollowing === null) isFollowing = fromGraph.isFollowing;
    if (isFollowedBy === null) isFollowedBy = fromGraph.isFollowedBy;
  }

  const normalizedFollowing = Boolean(isFollowing);
  const normalizedFollowedBy = Boolean(isFollowedBy);
  return {
    isFollowing: normalizedFollowing,
    isFollowedBy: normalizedFollowedBy,
    isMutual: normalizedFollowing && normalizedFollowedBy,
  };
};

const toUserSummary = (userRaw: any, viewerIdRaw?: any, relationshipRaw?: any) => {
  const user = toPlain(userRaw);
  if (!user) return null;
  const username = toText(user.username ?? user.user_name);
  const userId = Number(user.id ?? 0) || null;
  const activeOrbitReelId =
    Number(user.active_orbit_reel_id ?? user.activeOrbitReelId ?? 0) || null;
  const orbitRingUntil = toIsoDate(user.orbit_ring_until ?? user.orbitRingUntil);
  const explicitHasActiveOrbit = toBoolOrNull(
    user.has_active_orbit ??
      user.hasActiveOrbit ??
      user.has_orbit_ring ??
      user.hasOrbitRing
  );
  const hasActiveOrbit =
    explicitHasActiveOrbit ??
    Boolean(activeOrbitReelId && orbitRingUntil && new Date(orbitRingUntil).getTime() > Date.now());
  const relationship = resolveRelationshipFlags(user, viewerIdRaw, relationshipRaw);
  const profileVerified = Boolean(
    user.profile_verified ?? user.profileVerified ?? user.verified_badge ?? false
  );
  const profileVerificationStatus =
    toText(user.profile_verification_status ?? user.profileVerificationStatus) ?? null;
  const isAdmin = Boolean(user.is_admin ?? user.isAdmin ?? false);

  return {
    id: userId,
    username,
    name: [toText(user.name), toText(user.last_name)].filter(Boolean).join(" ") || null,
    avatar: toText(user.image_profil),
    verified: Boolean(user.verified),
    profile_verified: profileVerified,
    profileVerified,
    verified_badge: profileVerified,
    is_verified_profile: profileVerified,
    profile_verification_status: profileVerificationStatus,
    profileVerificationStatus: profileVerificationStatus,
    is_admin: isAdmin,
    isAdmin,
    relationship,
    isFollowing: relationship.isFollowing,
    is_following: relationship.isFollowing,
    viewerFollowsUser: relationship.isFollowing,
    viewer_follows_user: relationship.isFollowing,
    isFollowedBy: relationship.isFollowedBy,
    is_followed_by: relationship.isFollowedBy,
    userFollowsViewer: relationship.isFollowedBy,
    user_follows_viewer: relationship.isFollowedBy,
    isMutual: relationship.isMutual,
    is_mutual: relationship.isMutual,
    has_active_orbit: hasActiveOrbit,
    hasActiveOrbit: hasActiveOrbit,
    has_orbit_ring: hasActiveOrbit,
    hasOrbitRing: hasActiveOrbit,
    active_orbit_reel_id: hasActiveOrbit ? activeOrbitReelId : null,
    activeOrbitReelId: hasActiveOrbit ? activeOrbitReelId : null,
    orbit_ring_until: hasActiveOrbit ? orbitRingUntil : null,
    orbitRingUntil: hasActiveOrbit ? orbitRingUntil : null,
  };
};

const pickPrimaryMedia = (itemsRaw: any) => {
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const item = items[0] ? toPlain(items[0]) : null;
  if (!item) return null;
  const isImage = Boolean(item.is_img ?? item.isImage ?? item.is_image ?? false);
  const videoUid = toText(item.video_uid ?? item.videoUid);
  const thumbnailUrl =
    toText(item.thumbnail_url ?? item.thumbnailUrl ?? item.poster_url ?? item.posterUrl) ??
    (videoUid && !isImage
      ? `https://videodelivery.net/${videoUid}/thumbnails/thumbnail.jpg?time=1s`
      : null);
  const posterUrl = toText(item.poster_url ?? item.posterUrl ?? thumbnailUrl);
  return {
    url: toText(item.url ?? item.mediaUrl),
    is_image: isImage,
    is_img: isImage,
    video_uid: videoUid,
    videoUid,
    thumbnail_url: thumbnailUrl,
    thumbnailUrl,
    poster_url: posterUrl,
    posterUrl,
  };
};

const buildCounts = (source: any, extra?: Record<string, number>) => ({
  likes: toCount(source?.likes_count ?? source?.likes?.length),
  comments: toCount(source?.comments_count ?? source?.comments?.length),
  saves: toCount(source?.saved_count ?? source?.savedCount ?? source?.saves_count),
  shares: toCount(source?.shares_count),
  ...(extra ?? {}),
});

const summarizeMessage = (messageRaw: any, locale: AppLocale = "en") => {
  const message = toPlain(messageRaw);
  if (!message) return null;
  const dateIso = toIsoDate(message.date ?? message.createdAt ?? message.updatedAt);
  const relativeTime = formatRelativeTime(dateIso, locale);
  const messageType = toText(message.messageType ?? message.message_type) ?? "text";
  return {
    id: Number(message.id ?? 0) || null,
    text: truncateText(message.text, 90),
    type: messageType,
    senderId: Number(message.senderId ?? 0) || null,
    date: dateIso,
    status: toText(message.status),
    mediaUrl: refreshVoiceMediaUrl(
      messageType,
      toText(message.mediaUrl ?? message.media_url)
    ),
    relativeTime,
    relative_time: relativeTime,
  };
};

export const isSummaryMode = (value: any) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

export const isCompactMode = (value: any) => isSummaryMode(value);

export const toPostSummary = (
  postRaw: any,
  viewerIdRaw?: any,
  relationshipLookup?: any
) => {
  const post = toPlain(postRaw);
  const viewerId = Number(viewerIdRaw ?? 0);
  const authorId = Number(post?.user?.id ?? 0) || null;
  const relationship = getRelationshipFromLookup(relationshipLookup, authorId);
  const likes = Array.isArray(post?.likes) ? post.likes : [];
  const isSaved = pickFirstBool(post?.is_saved, post?.isSaved, post?.saved) ?? false;
  const isLiked =
    Boolean(post?.is_liked ?? post?.isLiked) ||
    likes.some((like: any) => Number(like?.userId) === viewerId);
  const createdAt = toIsoDate(post?.created_date ?? post?.createdAt ?? post?.updatedAt);
  const counts = buildCounts(post);
  const author = toUserSummary(post?.user, viewerIdRaw, relationship);
  const userRaw = toPlain(post?.user);
  const postMediaRaw = Array.isArray(post?.post_media) ? post.post_media : [];
  const postMedia = postMediaRaw.map((item: any) => {
    const isImage = Boolean(item?.is_img ?? item?.isImage ?? item?.is_image ?? false);
    const videoUid = toText(item?.video_uid ?? item?.videoUid);
    const thumbnailUrl =
      toText(item?.thumbnail_url ?? item?.thumbnailUrl ?? item?.poster_url ?? item?.posterUrl) ??
      (videoUid && !isImage
        ? `https://videodelivery.net/${videoUid}/thumbnails/thumbnail.jpg?time=1s`
        : null);
    const posterUrl = toText(item?.poster_url ?? item?.posterUrl ?? thumbnailUrl);
    return {
      url: toText(item?.url ?? item?.mediaUrl),
      is_img: isImage,
      is_image: isImage,
      video_uid: videoUid,
      videoUid,
      thumbnail_url: thumbnailUrl,
      thumbnailUrl,
      poster_url: posterUrl,
      posterUrl,
    };
  });

  const user = userRaw
    ? {
        id: Number(userRaw.id ?? 0) || null,
        name: toText(userRaw.name),
        last_name: toText(userRaw.last_name),
        lastName: toText(userRaw.last_name),
        username: toText(userRaw.username ?? userRaw.user_name),
        image_profil: toText(userRaw.image_profil),
        imageProfil: toText(userRaw.image_profil),
        avatar: toText(userRaw.image_profil),
        verified: Boolean(userRaw.verified),
        has_active_orbit: author?.has_active_orbit ?? false,
        hasActiveOrbit: author?.hasActiveOrbit ?? false,
        isFollowing: author?.isFollowing ?? false,
        is_following: author?.isFollowing ?? false,
      }
    : null;

  return {
    id: Number(post?.id ?? 0) || null,
    post: toText(post?.post),
    excerpt: truncateText(post?.post, 140),
    created_date: createdAt,
    createdAt,
    relative_time_es: formatRelativeTime(createdAt, "es"),
    relative_time_en: formatRelativeTime(createdAt, "en"),
    hashtags: toHashtagSummary(post?.hashtags),
    counts,
    likes_count: counts.likes,
    comments_count: counts.comments,
    saved_count: counts.saves,
    shares_count: counts.shares,
    post_media: postMedia,
    media: pickPrimaryMedia(post?.post_media),
    user,
    author,
    liked: isLiked,
    is_liked: isLiked,
    saved: isSaved,
    is_saved: isSaved,
    isSaved: isSaved,
    score:
      Number.isFinite(Number(post?.score))
        ? Number(post?.score)
        : Number.isFinite(Number(post?.feed_score))
        ? Number(post?.feed_score)
        : null,
    feed_score:
      Number.isFinite(Number(post?.feed_score))
        ? Number(post?.feed_score)
        : Number.isFinite(Number(post?.score))
        ? Number(post?.score)
        : null,
    rankingReason: post?.rankingReason ?? post?.ranking_reason ?? null,
    ranking_reason: post?.ranking_reason ?? post?.rankingReason ?? null,
  };
};

export const toReelSummary = (reelRaw: any, viewerIdRaw?: any, relationshipLookup?: any) => {
  const reel = toPlain(reelRaw);
  const creatorId = Number(reel?.user?.id ?? 0) || null;
  const relationship = getRelationshipFromLookup(relationshipLookup, creatorId);
  const isStarred =
    pickFirstBool(
      reel?.is_starred,
      reel?.isStarred,
      reel?.is_liked,
      reel?.isLiked,
      reel?.starred,
      reel?.liked
    ) ?? false;
  const isSaved =
    pickFirstBool(reel?.is_saved, reel?.isSaved, reel?.saved) ?? false;
  const videoUid = toText(reel?.video_uid ?? reel?.videoUid);
  const streamUrl = toText(reel?.stream_url ?? reel?.streamUrl);
  const downloadUrl = toText(reel?.download_url ?? reel?.downloadUrl);
  const thumbnailUrl =
    toText(reel?.thumbnail_url ?? reel?.thumbnailUrl) ??
    (videoUid ? `https://videodelivery.net/${videoUid}/thumbnails/thumbnail.jpg?time=1s` : null);
  const posterUrl = toText(reel?.poster_url ?? reel?.posterUrl ?? thumbnailUrl);
  const previewImageUrl = toText(reel?.image_url ?? reel?.imageUrl ?? thumbnailUrl);
  const startupPlaybackUrl = downloadUrl ?? streamUrl ?? previewImageUrl;
  const startupPlaybackType = downloadUrl ? "progressive" : toPlaybackType(startupPlaybackUrl);
  const handoffPlaybackUrl = streamUrl ?? null;
  return {
    id: Number(reel?.id ?? 0) || null,
    description: truncateText(reel?.description, 140),
    hashtags: toHashtagSummary(reel?.hashtags),
    thumbnail_url: thumbnailUrl,
    thumbnailUrl,
    thumbnail: thumbnailUrl,
    poster_url: posterUrl,
    posterUrl,
    image_url: previewImageUrl,
    imageUrl: previewImageUrl,
    cover_url: previewImageUrl,
    coverUrl: previewImageUrl,
    stream_url: streamUrl,
    streamUrl,
    download_url: downloadUrl,
    downloadUrl,
    startup_playback_url: startupPlaybackUrl,
    startupPlaybackUrl: startupPlaybackUrl,
    startup_playback_type: startupPlaybackType,
    startupPlaybackType: startupPlaybackType,
    handoff_playback_url: handoffPlaybackUrl,
    handoffPlaybackUrl: handoffPlaybackUrl,
    video_uid: videoUid,
    videoUid,
    media: {
      url: streamUrl,
      is_img: false,
      is_image: false,
      kind: "video",
      download_url: downloadUrl,
      downloadUrl,
      startup_playback_url: startupPlaybackUrl,
      startupPlaybackUrl: startupPlaybackUrl,
      startup_playback_type: startupPlaybackType,
      startupPlaybackType: startupPlaybackType,
      handoff_playback_url: handoffPlaybackUrl,
      handoffPlaybackUrl: handoffPlaybackUrl,
      thumbnail_url: thumbnailUrl,
      thumbnailUrl,
      poster_url: posterUrl,
      posterUrl,
      video_uid: videoUid,
      videoUid,
    },
    createdAt: toIsoDate(reel?.createdAt ?? reel?.updatedAt),
    counts: {
      likes: toCount(reel?.likes_count),
      comments: toCount(reel?.comments_count),
      saves: toCount(reel?.saves_count),
      views: toCount(reel?.views_count),
    },
    creator: toUserSummary(reel?.user, viewerIdRaw, relationship),
    starred: isStarred,
    liked: isStarred,
    saved: isSaved,
    is_starred: isStarred,
    isStarred: isStarred,
    is_liked: isStarred,
    isLiked: isStarred,
    is_saved: isSaved,
    isSaved: isSaved,
  };
};

const toCompactRelationship = (relationshipRaw: any) => {
  const relationship = toPlain(relationshipRaw) ?? {};
  const isFollowing = Boolean(relationship?.isFollowing ?? relationship?.is_following ?? false);
  const isFollowedBy = Boolean(
    relationship?.isFollowedBy ?? relationship?.is_followed_by ?? false
  );
  return {
    isFollowing,
    isFollowedBy,
    isMutual: isFollowing && isFollowedBy,
  };
};

const toCompactUser = (userRaw: any) => {
  const user = toPlain(userRaw);
  if (!user) return null;
  const relationship = toCompactRelationship(user?.relationship);
  return {
    id: Number(user?.id ?? 0) || null,
    username: toText(user?.username ?? user?.user_name),
    name: toText(user?.name),
    avatar: toText(user?.avatar ?? user?.image_profil),
    verified: Boolean(user?.verified),
    profile_verified: Boolean(
      user?.profile_verified ?? user?.profileVerified ?? user?.verified_badge ?? false
    ),
    is_admin: Boolean(user?.is_admin ?? user?.isAdmin ?? false),
    relationship,
    has_active_orbit: Boolean(user?.has_active_orbit ?? user?.hasActiveOrbit ?? false),
    active_orbit_reel_id: Number(user?.active_orbit_reel_id ?? user?.activeOrbitReelId ?? 0) || null,
    orbit_ring_until: toIsoDate(user?.orbit_ring_until ?? user?.orbitRingUntil),
  };
};

export const toPostSummaryCompact = (postSummaryRaw: any) => {
  const post = toPlain(postSummaryRaw);
  if (!post) return null;
  const media = toPlain(post?.media ?? post?.post_media?.[0]) ?? null;
  const isImage = Boolean(media?.is_image ?? media?.is_img ?? false);
  const videoUid = toText(media?.video_uid ?? media?.videoUid);
  const thumbnailUrl = toText(media?.thumbnail_url ?? media?.thumbnailUrl);
  const posterUrl = toText(media?.poster_url ?? media?.posterUrl ?? thumbnailUrl);

  return {
    id: Number(post?.id ?? 0) || null,
    post: toText(post?.post),
    excerpt: toText(post?.excerpt),
    created_at: toIsoDate(post?.created_date ?? post?.createdAt),
    relative_time_es: toText(post?.relative_time_es),
    relative_time_en: toText(post?.relative_time_en),
    hashtags: Array.isArray(post?.hashtags) ? post.hashtags : [],
    counts: {
      likes: toCount(post?.counts?.likes ?? post?.likes_count),
      comments: toCount(post?.counts?.comments ?? post?.comments_count),
      saves: toCount(post?.counts?.saves ?? post?.saved_count),
      shares: toCount(post?.counts?.shares ?? post?.shares_count),
    },
    media: media
      ? {
          kind: isImage ? "image" : videoUid ? "video" : "unknown",
          url: toText(media?.url),
          is_image: isImage,
          video_uid: videoUid,
          thumbnail_url: thumbnailUrl,
          poster_url: posterUrl,
        }
      : null,
    author: toCompactUser(post?.author ?? post?.user),
    liked: Boolean(post?.liked ?? post?.is_liked ?? false),
    saved: Boolean(post?.saved ?? post?.is_saved ?? false),
    score:
      Number.isFinite(Number(post?.score))
        ? Number(post?.score)
        : Number.isFinite(Number(post?.feed_score))
        ? Number(post?.feed_score)
        : null,
    ranking_reason: toText(post?.ranking_reason ?? post?.rankingReason),
  };
};

export const toReelSummaryCompact = (reelSummaryRaw: any) => {
  const reel = toPlain(reelSummaryRaw);
  if (!reel) return null;
  const media = toPlain(reel?.media) ?? {};
  const videoUid = toText(media?.video_uid ?? media?.videoUid ?? reel?.video_uid ?? reel?.videoUid);
  const thumbnailUrl = toText(media?.thumbnail_url ?? media?.thumbnailUrl ?? reel?.thumbnail_url);
  const posterUrl = toText(media?.poster_url ?? media?.posterUrl ?? reel?.poster_url ?? thumbnailUrl);
  const startupPlaybackUrl = toText(
    media?.startup_playback_url ?? media?.startupPlaybackUrl ?? reel?.startup_playback_url
  );
  const startupPlaybackType = toText(
    media?.startup_playback_type ?? media?.startupPlaybackType ?? reel?.startup_playback_type
  );
  const handoffPlaybackUrl = toText(
    media?.handoff_playback_url ?? media?.handoffPlaybackUrl ?? reel?.handoff_playback_url
  );

  return {
    id: Number(reel?.id ?? 0) || null,
    description: toText(reel?.description),
    hashtags: Array.isArray(reel?.hashtags) ? reel.hashtags : [],
    created_at: toIsoDate(reel?.createdAt ?? reel?.created_at),
    counts: {
      likes: toCount(reel?.counts?.likes),
      comments: toCount(reel?.counts?.comments),
      saves: toCount(reel?.counts?.saves),
      views: toCount(reel?.counts?.views),
    },
    media: {
      kind: "video",
      stream_url: toText(media?.url ?? reel?.stream_url ?? reel?.streamUrl),
      download_url: toText(media?.download_url ?? media?.downloadUrl ?? reel?.download_url),
      startup_playback_url: startupPlaybackUrl,
      startup_playback_type: startupPlaybackType,
      handoff_playback_url: handoffPlaybackUrl,
      thumbnail_url: thumbnailUrl,
      poster_url: posterUrl,
      video_uid: videoUid,
    },
    creator: toCompactUser(reel?.creator),
    liked: Boolean(reel?.liked ?? reel?.is_liked ?? false),
    saved: Boolean(reel?.saved ?? reel?.is_saved ?? false),
  };
};

export const toServiceSummary = (serviceRaw: any, viewerIdRaw?: any, relationshipLookup?: any) => {
  const service = enrichServiceApplicantsStatus(toPlain(serviceRaw));
  const categoryName = toText(service?.category?.name ?? service?.category?.es_name);
  const description = truncateText(service?.description, 120);
  const currency = toText(service?.currencyPrefix ?? service?.currency_prefix) ?? "";
  const rate = Number(service?.rate);
  const price = Number.isFinite(rate) ? `${currency}${rate}`.trim() : null;
  const applicantsCount = resolveApplicantsCount(service);
  const applicantsStatus = normalizeApplicantsStatus(
    service?.applicants_status ?? service?.applicantsStatus ?? buildApplicantsStatus(applicantsCount),
    applicantsCount
  );
  const canApply = Boolean(service?.can_apply ?? service?.canApply);
  const providerRaw =
    service?.client ??
    service?.workers?.[0]?.personal_data ??
    service?.offers?.[0]?.offerer?.personal_data;
  const providerId = Number(providerRaw?.id ?? 0) || null;
  const relationship = getRelationshipFromLookup(relationshipLookup, providerId);
  const provider = toUserSummary(providerRaw, viewerIdRaw, relationship);
  const routing = buildServiceRoutingFields(service);

  return {
    id: Number(service?.id ?? 0) || null,
    title: categoryName ?? description,
    short_description: description,
    price,
    thumbnail:
      toText(provider?.avatar) ??
      toText(service?.offers?.[0]?.offerer?.personal_data?.image_profil) ??
      null,
    provider,
    status: routing.status,
    status_id: routing.status_id,
    statusId: routing.statusId,
    accepted_count: routing.accepted_count,
    acceptedCount: routing.acceptedCount,
    has_assigned_workers: routing.has_assigned_workers,
    hasAssignedWorkers: routing.hasAssignedWorkers,
    client_bucket: routing.client_bucket,
    clientBucket: routing.clientBucket,
    manual_close_required: routing.manual_close_required,
    manualCloseRequired: routing.manualCloseRequired,
    manual_closed_at: routing.manual_closed_at,
    manualClosedAt: routing.manualClosedAt,
    closed_at: routing.closed_at,
    closedAt: routing.closedAt,
    applicants_count: applicantsCount,
    applicantsCount,
    applicants_status: applicantsStatus,
    applicantsStatus,
    can_apply: canApply,
    canApply,
    createdAt: toIsoDate(service?.service_date ?? service?.createdAt),
    score:
      Number.isFinite(Number(service?.score))
        ? Number(service?.score)
        : Number.isFinite(Number(service?.feed_score))
        ? Number(service?.feed_score)
        : null,
    feed_score:
      Number.isFinite(Number(service?.feed_score))
        ? Number(service?.feed_score)
        : Number.isFinite(Number(service?.score))
        ? Number(service?.score)
        : null,
    rankingReason: service?.rankingReason ?? service?.ranking_reason ?? null,
    ranking_reason: service?.ranking_reason ?? service?.rankingReason ?? null,
  };
};

const buildNotificationTarget = (notification: any) => {
  if (notification?.post) {
    return {
      kind: "post",
      id: Number(notification.post.id ?? 0) || null,
      excerpt: truncateText(notification.post?.post, 100),
      media: pickPrimaryMedia(notification.post?.post_media),
    };
  }

  if (notification?.reel) {
    return {
      kind: "reel",
      id: Number(notification.reel.id ?? 0) || null,
      excerpt: truncateText(notification.reel?.description, 100),
      thumbnail: toText(notification.reel?.thumbnail_url),
    };
  }

  if (notification?.service) {
    return {
      kind: "service",
      id: Number(notification.service.id ?? 0) || null,
      excerpt: truncateText(notification.service?.description, 100),
      rate: Number(notification.service?.rate ?? 0) || null,
    };
  }

  if (notification?.message_received) {
    return {
      kind: "message",
      id: Number(notification.message_received.id ?? 0) || null,
      excerpt: truncateText(notification.message_received?.text, 80),
    };
  }

  if (notification?.offer) {
    return {
      kind: "offer",
      id: Number(notification.offer.id ?? 0) || null,
      serviceId: Number(notification.offer.serviceId ?? 0) || null,
    };
  }

  return null;
};

export const toNotificationSummary = (
  notificationRaw: any,
  locale: AppLocale = "en"
) => {
  const notification = toPlain(notificationRaw);
  const createdAt = toIsoDate(notification?.notification_date ?? notification?.createdAt);
  const relativeTime = formatRelativeTime(createdAt, locale);
  return {
    id: Number(notification?.id ?? 0) || null,
    type: toText(notification?.type),
    createdAt,
    relativeTime,
    relative_time: relativeTime,
    actor: toUserSummary(notification?.interactor),
    target: buildNotificationTarget(notification),
    read: Boolean(notification?.read),
  };
};

export const toFollowSummary = (entryRaw: any) => {
  const entry = toPlain(entryRaw);
  const user = entry?.user ? toPlain(entry.user) : toPlain(entry?.following_data ?? entry?.follower_data);
  const isFollowing =
    pickFirstBool(
      entry?.isFollowing,
      entry?.is_following,
      entry?.viewerFollowsUser,
      entry?.viewer_follows_user,
      entry?.flags?.viewerFollowsUser
    ) ?? false;
  const isFollowedBy =
    pickFirstBool(
      entry?.isFollowedBy,
      entry?.is_followed_by,
      entry?.userFollowsViewer,
      entry?.user_follows_viewer,
      entry?.flags?.userFollowsViewer
    ) ?? false;
  const isMutual =
    pickFirstBool(entry?.isMutual, entry?.is_mutual, entry?.flags?.isMutual) ??
    (isFollowing && isFollowedBy);
  const id = Number(user?.id ?? entry?.id ?? 0) || null;
  const name = toText(user?.name);
  const lastName = toText(user?.last_name);
  const fullName = [name, lastName].filter(Boolean).join(" ") || null;
  const username = toText(user?.username ?? user?.user_name);
  const avatar = toText(user?.image_profil);
  const verified = Boolean(user?.verified);
  const profileVerified = Boolean(
    user?.profile_verified ?? user?.profileVerified ?? user?.verified_badge ?? false
  );
  const profileVerificationStatus =
    toText(user?.profile_verification_status ?? user?.profileVerificationStatus) ?? null;
  const compactUser = {
    id,
    name,
    last_name: lastName,
    full_name: fullName,
    username,
    user_name: username,
    avatar,
    image_profil: avatar,
    verified,
    profile_verified: profileVerified,
    profileVerified,
    verified_badge: profileVerified,
    is_verified_profile: profileVerified,
    profile_verification_status: profileVerificationStatus,
    profileVerificationStatus: profileVerificationStatus,
  };
  const activeOrbitReelId =
    Number(user?.active_orbit_reel_id ?? user?.activeOrbitReelId ?? 0) || null;
  const orbitRingUntil = toIsoDate(user?.orbit_ring_until ?? user?.orbitRingUntil);
  const explicitHasActiveOrbit = toBoolOrNull(
    user?.has_active_orbit ??
      user?.hasActiveOrbit ??
      user?.has_orbit_ring ??
      user?.hasOrbitRing
  );
  const hasActiveOrbit =
    explicitHasActiveOrbit ??
    Boolean(activeOrbitReelId && orbitRingUntil && new Date(orbitRingUntil).getTime() > Date.now());

  return {
    id,
    name,
    last_name: lastName,
    full_name: fullName,
    username,
    user_name: username,
    avatar,
    image_profil: avatar,
    profile_verified: profileVerified,
    profileVerified,
    verified_badge: profileVerified,
    is_verified_profile: profileVerified,
    profile_verification_status: profileVerificationStatus,
    profileVerificationStatus: profileVerificationStatus,
    user: compactUser,
    following_data: compactUser,
    follower_data: compactUser,
    has_active_orbit: hasActiveOrbit,
    hasActiveOrbit: hasActiveOrbit,
    has_orbit_ring: hasActiveOrbit,
    hasOrbitRing: hasActiveOrbit,
    active_orbit_reel_id: hasActiveOrbit ? activeOrbitReelId : null,
    activeOrbitReelId: hasActiveOrbit ? activeOrbitReelId : null,
    orbit_ring_until: hasActiveOrbit ? orbitRingUntil : null,
    orbitRingUntil: hasActiveOrbit ? orbitRingUntil : null,
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
    flags: {
      verified,
      profileVerified,
      isMutual,
      viewerFollowsUser: isFollowing,
      userFollowsViewer: isFollowedBy,
    },
  };
};

export const toChatSummary = (
  chatRowRaw: any,
  locale: AppLocale = "en",
  viewerIdRaw?: any,
  relationshipLookup?: any
) => {
  const row = toPlain(chatRowRaw);
  const chat = toPlain(row?.Chat);
  const otherUser = Array.isArray(chat?.users) ? chat.users[0] : null;
  const otherUserId = Number(otherUser?.id ?? 0) || null;
  const relationship = getRelationshipFromLookup(relationshipLookup, otherUserId);
  const lastMessage = Array.isArray(chat?.messages) ? chat.messages[0] : null;
  const updatedAt = toIsoDate(
    lastMessage?.date ?? row?.updatedAt ?? chat?.updatedAt ?? row?.createdAt
  );
  const relativeTime = formatRelativeTime(updatedAt, locale);
  return {
    chatId: Number(row?.chatId ?? chat?.id ?? 0) || null,
    lastMessage: summarizeMessage(lastMessage, locale),
    unreadCount: toCount(chat?.unreadCount ?? row?.unreadCount),
    updatedAt,
    relativeTime,
    relative_time: relativeTime,
    user: toUserSummary(otherUser, viewerIdRaw, relationship),
  };
};

export const toChatMessageSummary = (messageRaw: any, locale: AppLocale = "en") => {
  const message = summarizeMessage(messageRaw, locale);
  const raw = toPlain(messageRaw);
  return {
    ...message,
    sender: toUserSummary(raw?.sender),
    replyToMessageId: Number(raw?.replyToMessageId ?? 0) || null,
  };
};
