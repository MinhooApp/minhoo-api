import {
  Request,
  Response,
  formatResponse,
  repository,
  socket,
  sendNotification,
} from "../_module/module";
import { emitOrbitRingUpdatedRealtime } from "../../../libs/helper/realtime_dispatch";
import { getActiveOrbitStateByUser } from "../../../repository/reel/orbit_ring_projection";
import { formatRelativeTime } from "../../../libs/localization/relative_time";
import { bumpHomeContentSectionVersion } from "../../../libs/cache/bootstrap_home_cache_version";
import { applyCreateContentIdempotency } from "../../../libs/idempotency/content_create_idempotency";
import { isHashtagValidationError, sendHashtagError } from "../../../libs/hashtags";

const parseBool = (value: any, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return fallback;
};

const REEL_VALIDATE_STREAM_VARIANTS = parseBool(
  process.env.REEL_VALIDATE_STREAM_VARIANTS,
  true
);
const REEL_ENFORCE_SAFE_STREAM_VARIANTS = parseBool(
  process.env.REEL_ENFORCE_SAFE_STREAM_VARIANTS,
  false
);
const REEL_ALLOW_UNSAFE_STREAM_VARIANTS = parseBool(
  process.env.REEL_ALLOW_UNSAFE_STREAM_VARIANTS,
  true
);
const REEL_STARTUP_SAFE_MAX_FPS = Math.max(
  24,
  Number(process.env.REEL_STARTUP_SAFE_MAX_FPS ?? 30) || 30
);
const REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH = Math.max(
  120_000,
  Number(process.env.REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH ?? 550_000) || 550_000
);
const REEL_ENFORCE_SAFE_STREAM_MIN_BITRATE = parseBool(
  process.env.REEL_ENFORCE_SAFE_STREAM_MIN_BITRATE,
  false
);
const REEL_ALLOW_UNSAFE_STREAM_MIN_BITRATE = parseBool(
  process.env.REEL_ALLOW_UNSAFE_STREAM_MIN_BITRATE,
  true
);
const REEL_STREAM_PROFILE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.REEL_STREAM_PROFILE_TIMEOUT_MS ?? 3000) || 3000
);
const REEL_STREAM_PROFILE_CACHE_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.REEL_STREAM_PROFILE_CACHE_TTL_MS ?? 10 * 60 * 1000) ||
    10 * 60 * 1000
);
// Rolled back per product request: disable strict readiness gate for now.
const REEL_ENFORCE_STREAM_ASSET_READY = false;
const REEL_STREAM_ASSET_LOOKUP_TIMEOUT_MS = Math.max(
  1500,
  Number(process.env.REEL_STREAM_ASSET_LOOKUP_TIMEOUT_MS ?? 5000) || 5000
);
const REEL_STREAM_WARMUP_ENABLED = parseBool(
  process.env.REEL_STREAM_WARMUP_ENABLED,
  true
);
const REEL_STREAM_WARMUP_TIMEOUT_MS = Math.max(
  400,
  Number(process.env.REEL_STREAM_WARMUP_TIMEOUT_MS ?? 2500) || 2500
);
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

type ReelHlsVariantProfile = {
  url: string;
  bandwidth: number | null;
  frameRate: number | null;
  resolution: string | null;
};

type ReelHlsManifestProfile = {
  sourceUrl: string;
  variantCount: number;
  safeVariantCount: number;
  safeMinBandwidthVariantCount: number;
  minBandwidth: number | null;
  maxBandwidth: number | null;
  maxFrameRate: number | null;
  hasUnsafeFrameRate: boolean;
  hasUnsafeMinBandwidth: boolean;
  inspectedAt: string;
  checkError: string | null;
};

type CloudflareStreamLookup = {
  ok: boolean;
  exists: boolean;
  ready: boolean;
  state: string | null;
  streamUrl: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  reason?: string;
};

const reelHlsProfileCache = new Map<
  string,
  { expiresAt: number; profile: ReelHlsManifestProfile | null }
>();

const normalizeVideoUid = (value: any): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^[a-f0-9]{32}$/i.test(raw)) return null;
  return raw.toLowerCase();
};

const getCloudflareStreamConfig = () => {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = String(
    process.env.CLOUDFLARE_MEDIA_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();
  return { accountId, token };
};

const readCloudflareStreamLookup = async (
  uid: string
): Promise<CloudflareStreamLookup> => {
  const cfg = getCloudflareStreamConfig();
  if (!cfg.accountId || !cfg.token) {
    return {
      ok: false,
      exists: false,
      ready: false,
      state: null,
      streamUrl: null,
      thumbnailUrl: null,
      durationSeconds: null,
      reason: "missing_cloudflare_config",
    };
  }

  try {
    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${cfg.accountId}/stream/${encodeURIComponent(uid)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REEL_STREAM_ASSET_LOOKUP_TIMEOUT_MS),
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const firstCode = Number(payload?.errors?.[0]?.code ?? 0) || null;
      const firstMessage = String(payload?.errors?.[0]?.message ?? "").trim();
      if (response.status === 404 || firstCode === 10003) {
        return {
          ok: true,
          exists: false,
          ready: false,
          state: "not_found",
          streamUrl: null,
          thumbnailUrl: null,
          durationSeconds: null,
          reason: "not_found",
        };
      }
      return {
        ok: false,
        exists: false,
        ready: false,
        state: null,
        streamUrl: null,
        thumbnailUrl: null,
        durationSeconds: null,
        reason: firstMessage || `lookup_http_${response.status}`,
      };
    }

    const result = payload?.result ?? {};
    const state = String(result?.status?.state ?? "").trim().toLowerCase() || null;
    const ready = Boolean(result?.readyToStream);
    const hls =
      String(result?.playback?.hls ?? "").trim() || buildDefaultStreamUrl(uid) || null;
    const thumbnail =
      String(result?.thumbnail ?? "").trim() ||
      buildDefaultThumbnailUrl(uid, hls);
    const durationRaw = Number(result?.duration ?? 0);
    const durationSeconds =
      Number.isFinite(durationRaw) && durationRaw > 0 ? Math.floor(durationRaw) : null;

    return {
      ok: true,
      exists: true,
      ready,
      state,
      streamUrl: hls,
      thumbnailUrl: thumbnail,
      durationSeconds,
    };
  } catch (error: any) {
    return {
      ok: false,
      exists: false,
      ready: false,
      state: null,
      streamUrl: null,
      thumbnailUrl: null,
      durationSeconds: null,
      reason: String(error?.message ?? "stream_lookup_failed"),
    };
  }
};

const readFirstPlaylistUri = (manifestRaw: string): string | null => {
  const lines = String(manifestRaw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
};

const safeWarmupFetch = async (urlRaw: string, timeoutMs: number) => {
  const url = String(urlRaw ?? "").trim();
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept:
          "application/vnd.apple.mpegurl,application/x-mpegURL,application/x-mpegurl,*/*",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      text,
      finalUrl: response.url || url,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      text: "",
      finalUrl: url,
      error: String(error?.message ?? "fetch_failed"),
    };
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));

const isAbsoluteHttpUrl = (valueRaw: any) => {
  const value = String(valueRaw ?? "").trim();
  return /^https?:\/\//i.test(value);
};

const resolveWarmupMasterUrl = (uid: string, streamUrlRaw: any) => {
  const streamUrl = String(streamUrlRaw ?? "").trim();
  if (isAbsoluteHttpUrl(streamUrl) && /\.m3u8($|\?)/i.test(streamUrl)) return streamUrl;
  return buildDefaultStreamUrl(uid);
};

const parseWarmupDelayOffsetsMs = () => {
  const raw = String(process.env.REEL_STREAM_WARMUP_DELAY_OFFSETS_MS ?? "0,7000,20000")
    .split(",")
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry >= 0)
    .map((entry) => Math.floor(entry));
  const unique = Array.from(new Set(raw)).sort((a, b) => a - b);
  return unique.length ? unique : [0];
};

const warmUpReelStreamAssets = async (params: {
  userId: number;
  videoUid: string;
  streamUrl: string | null;
  thumbnailUrl: string | null;
  phase?: string;
}): Promise<boolean> => {
  if (!REEL_STREAM_WARMUP_ENABLED) return false;
  const uid = normalizeVideoUid(params.videoUid);
  if (!uid) return false;

  const masterUrl = resolveWarmupMasterUrl(uid, params.streamUrl);
  const maxAttempts = Math.max(
    1,
    Number(process.env.REEL_STREAM_WARMUP_ATTEMPTS ?? 6) || 6
  );
  const retryBaseMs = Math.max(
    200,
    Number(process.env.REEL_STREAM_WARMUP_RETRY_BASE_MS ?? 1500) || 1500
  );
  const phase = String(params.phase ?? "immediate").trim() || "immediate";

  let master: Awaited<ReturnType<typeof safeWarmupFetch>> | null = null;
  let variant: Awaited<ReturnType<typeof safeWarmupFetch>> | null = null;
  let segment: Awaited<ReturnType<typeof safeWarmupFetch>> | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    master = await safeWarmupFetch(masterUrl, REEL_STREAM_WARMUP_TIMEOUT_MS);
    variant = null;
    segment = null;

    if (master?.ok && master.text) {
      const firstVariantUri = readFirstPlaylistUri(master.text);
      if (firstVariantUri) {
        let variantUrl = firstVariantUri;
        try {
          variantUrl = new URL(firstVariantUri, master.finalUrl ?? masterUrl).toString();
        } catch {
          // use raw path
        }

        variant = await safeWarmupFetch(variantUrl, REEL_STREAM_WARMUP_TIMEOUT_MS);
        if (variant?.ok && variant.text) {
          const firstSegmentUri = readFirstPlaylistUri(variant.text);
          if (firstSegmentUri) {
            let segmentUrl = firstSegmentUri;
            try {
              segmentUrl = new URL(firstSegmentUri, variant.finalUrl ?? variantUrl).toString();
            } catch {
              // use raw path
            }
            segment = await safeWarmupFetch(segmentUrl, REEL_STREAM_WARMUP_TIMEOUT_MS);
          }
        }
      }
      break;
    }

    if (attempt < maxAttempts) {
      await sleep(retryBaseMs * attempt);
    }
  }

  const warmed = Boolean(master?.ok);

  const providedThumbUrl = String(params.thumbnailUrl ?? "").trim();
  const thumbUrl =
    (isAbsoluteHttpUrl(providedThumbUrl) ? providedThumbUrl : "") ||
    buildDefaultThumbnailUrl(uid, master?.finalUrl ?? params.streamUrl);
  const thumbnail = await safeWarmupFetch(thumbUrl, REEL_STREAM_WARMUP_TIMEOUT_MS);

  console.log(
    `[reel-warmup] userId=${params.userId} uid=${uid} phase=${phase} attempts_used=${attemptsUsed}/${maxAttempts} warmed=${warmed} master=${
      master?.status ?? 0
    } variant=${variant?.status ?? 0} segment=${segment?.status ?? 0} thumb=${thumbnail?.status ?? 0}`
  );
  return warmed;
};

const parseM3u8NumberAttr = (
  attrsRaw: string,
  key: "BANDWIDTH" | "FRAME-RATE"
): number | null => {
  const match = attrsRaw.match(new RegExp(`${key}=([0-9]+(?:\\.[0-9]+)?)`, "i"));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseM3u8TextAttr = (attrsRaw: string, key: "RESOLUTION"): string | null => {
  const match = attrsRaw.match(new RegExp(`${key}=([^,\\s]+)`, "i"));
  if (!match) return null;
  const value = String(match[1] ?? "").trim();
  return value || null;
};

const parseHlsVariantProfiles = (
  manifestRaw: string,
  baseUrlRaw: string
): ReelHlsVariantProfile[] => {
  const lines = String(manifestRaw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const profiles: ReelHlsVariantProfile[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.toUpperCase().startsWith("#EXT-X-STREAM-INF:")) continue;

    const attrs = line.slice(line.indexOf(":") + 1);
    let uri: string | null = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (!candidate || candidate.startsWith("#")) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;

    let url = uri;
    try {
      url = new URL(uri, baseUrlRaw).toString();
    } catch {
      // Keep original uri when URL cannot be resolved as absolute.
      url = uri;
    }

    profiles.push({
      url,
      bandwidth: parseM3u8NumberAttr(attrs, "BANDWIDTH"),
      frameRate: parseM3u8NumberAttr(attrs, "FRAME-RATE"),
      resolution: parseM3u8TextAttr(attrs, "RESOLUTION"),
    });
  }

  return profiles;
};

const inspectReelHlsManifestProfile = async (
  sourceUrlRaw: string
): Promise<ReelHlsManifestProfile | null> => {
  const sourceUrl = String(sourceUrlRaw ?? "").trim();
  if (!sourceUrl || !/\.m3u8($|\?)/i.test(sourceUrl)) return null;

  const now = Date.now();
  const cached = reelHlsProfileCache.get(sourceUrl);
  if (cached && cached.expiresAt > now) {
    return cached.profile;
  }

  const inspectedAt = new Date().toISOString();
  let profile: ReelHlsManifestProfile | null = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REEL_STREAM_PROFILE_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      profile = {
        sourceUrl,
        variantCount: 0,
        safeVariantCount: 0,
        safeMinBandwidthVariantCount: 0,
        minBandwidth: null,
        maxBandwidth: null,
        maxFrameRate: null,
        hasUnsafeFrameRate: false,
        hasUnsafeMinBandwidth: false,
        inspectedAt,
        checkError: `manifest_http_${response.status}`,
      };
    } else {
      const manifestText = await response.text();
      const variants = parseHlsVariantProfiles(manifestText, sourceUrl);
      const minBandwidth = variants.reduce<number | null>((min, variant) => {
        if (!variant.bandwidth) return min;
        if (min == null) return variant.bandwidth;
        return variant.bandwidth < min ? variant.bandwidth : min;
      }, null);
      const maxBandwidth = variants.reduce<number | null>((max, variant) => {
        if (!variant.bandwidth) return max;
        if (max == null) return variant.bandwidth;
        return variant.bandwidth > max ? variant.bandwidth : max;
      }, null);
      const maxFrameRate = variants.reduce<number | null>((max, variant) => {
        if (!variant.frameRate) return max;
        if (max == null) return variant.frameRate;
        return variant.frameRate > max ? variant.frameRate : max;
      }, null);
      const safeVariants = variants.filter(
        (variant) =>
          variant.frameRate == null ||
          variant.frameRate <= REEL_STARTUP_SAFE_MAX_FPS + 0.001
      );
      const safeMinBandwidthVariants = variants.filter(
        (variant) =>
          variant.bandwidth == null ||
          variant.bandwidth <= REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH + 1
      );
      profile = {
        sourceUrl,
        variantCount: variants.length,
        safeVariantCount: safeVariants.length,
        safeMinBandwidthVariantCount: safeMinBandwidthVariants.length,
        minBandwidth,
        maxBandwidth,
        maxFrameRate,
        hasUnsafeFrameRate: variants.some(
          (variant) =>
            variant.frameRate != null &&
            variant.frameRate > REEL_STARTUP_SAFE_MAX_FPS + 0.001
        ),
        hasUnsafeMinBandwidth: variants.some(
          (variant) =>
            variant.bandwidth != null &&
            variant.bandwidth > REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH + 1
        ),
        inspectedAt,
        checkError: null,
      };
    }
  } catch (error: any) {
      profile = {
        sourceUrl,
        variantCount: 0,
        safeVariantCount: 0,
        safeMinBandwidthVariantCount: 0,
        minBandwidth: null,
        maxBandwidth: null,
        maxFrameRate: null,
        hasUnsafeFrameRate: false,
        hasUnsafeMinBandwidth: false,
        inspectedAt,
        checkError: String(error?.message ?? "manifest_check_failed"),
      };
  } finally {
    clearTimeout(timeout);
  }

  reelHlsProfileCache.set(sourceUrl, {
    profile,
    expiresAt: now + REEL_STREAM_PROFILE_CACHE_TTL_MS,
  });
  return profile;
};

const parseVisibility = (value: any) => {
  const v = String(value ?? "public").trim().toLowerCase();
  if (["public", "followers", "private"].includes(v)) return v;
  return "public";
};

const parseJSON = (value: any) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const toIsoOrNull = (value: any): string | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const toPlainObject = (value: any): any => {
  if (!value) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.dataValues && typeof value.dataValues === "object") {
    return { ...value.dataValues };
  }
  return value;
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
  if (!videoUid) return "";
  const baseUrl = getStreamPlaybackBaseUrl();
  if (baseUrl) return `${baseUrl}/${videoUid}/manifest/video.m3u8`;
  return `https://videodelivery.net/${videoUid}/manifest/video.m3u8`;
};

const buildDefaultThumbnailUrl = (videoUidRaw: any, streamUrlRaw?: any) => {
  const uid = String(videoUidRaw ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(uid)) return "";

  const streamUrl = String(streamUrlRaw ?? "").trim();
  if (streamUrl) {
    try {
      const parsed = new URL(streamUrl);
      const origin = String(parsed.origin ?? "").trim().replace(/\/+$/, "");
      if (origin) return `${origin}/${uid}/thumbnails/thumbnail.jpg?time=1s`;
    } catch {
      // ignore malformed stream URL
    }
  }

  const baseUrl = getStreamPlaybackBaseUrl();
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const origin = String(parsed.origin ?? "").trim().replace(/\/+$/, "");
      if (origin) return `${origin}/${uid}/thumbnails/thumbnail.jpg?time=1s`;
    } catch {
      // ignore malformed playback base URL
    }
  }

  return `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=1s`;
};

const buildImagePlaybackPath = (imageIdRaw: any) => {
  const imageId = String(imageIdRaw ?? "").trim();
  if (!imageId) return "";
  return `/api/v1/media/image/play?id=${encodeURIComponent(imageId)}`;
};

const normalizeImageVariantUrl = (value: any) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith('/api/v1/media/image/play')) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return raw;
};

const normalizeReelCommentPayload = (raw: any) => {
  const source = toPlainObject(raw) ?? {};
  const commentUser = toPlainObject(source.comment_user ?? source.commentUser ?? null);
  const createdAt = toIsoOrNull(source.createdAt ?? source.created_at);
  const updatedAt = toIsoOrNull(source.updatedAt ?? source.updated_at);
  const relativeTimeEn = formatRelativeTime(createdAt, "en");
  const relativeTimeEs = formatRelativeTime(createdAt, "es");

  return {
    ...source,
    reel_id: Number(source.reel_id ?? source.reelId ?? 0) || null,
    reelId: Number(source.reelId ?? source.reel_id ?? 0) || null,
    user_id: Number(source.user_id ?? source.userId ?? 0) || null,
    userId: Number(source.userId ?? source.user_id ?? 0) || null,
    comment_user: commentUser,
    commentUser: commentUser,
    createdAt,
    created_at: createdAt,
    updatedAt,
    updated_at: updatedAt,
    relativeTime: relativeTimeEn,
    relative_time: relativeTimeEn,
    relativeTimeEn: relativeTimeEn,
    relative_time_en: relativeTimeEn,
    relativeTimeEs: relativeTimeEs,
    relative_time_es: relativeTimeEs,
  };
};

const parseBoolOrNull = (value: any): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(v)) return true;
    if (["0", "false", "no"].includes(v)) return false;
  }
  return null;
};

const normalizeReelFreshnessState = (rawReel: any) => {
  const reel = toPlainObject(rawReel) ?? {};
  const ringUntilIso =
    toIsoOrNull(reel?.ring_until ?? reel?.ringUntil ?? reel?.new_until ?? reel?.newUntil) ??
    null;
  const explicitRingActive = parseBoolOrNull(reel?.ring_active ?? reel?.ringActive);
  const explicitIsNew = parseBoolOrNull(reel?.is_new ?? reel?.isNew);
  const fallbackRingActive =
    ringUntilIso !== null ? new Date(ringUntilIso).getTime() > Date.now() : false;

  const ringActive = explicitRingActive ?? explicitIsNew ?? fallbackRingActive;
  const ringUntil =
    ringUntilIso ??
    toIsoOrNull(reel?.new_until ?? reel?.newUntil) ??
    null;
  const isNew = explicitIsNew ?? ringActive;
  const newUntil =
    toIsoOrNull(reel?.new_until ?? reel?.newUntil ?? ringUntil) ??
    ringUntil;

  return {
    ringActive,
    ringUntil,
    isNew,
    newUntil,
  };
};

const buildReelRealtimePayload = (action: "created" | "updated", rawReel: any, fallbackOwnerIdRaw: any) => {
  const reel = toPlainObject(rawReel) ?? {};
  const reelId = Number(reel?.id ?? reel?.reelId ?? reel?.reel_id ?? 0);
  if (!Number.isFinite(reelId) || reelId <= 0) return null;

  const ownerId = Number(
    reel?.user?.id ?? reel?.userId ?? reel?.user_id ?? fallbackOwnerIdRaw ?? 0
  );
  const freshness = normalizeReelFreshnessState(reel);
  const normalizedReel = {
    ...reel,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
  };

  return {
    action,
    reelId,
    reel_id: reelId,
    ownerId: Number.isFinite(ownerId) && ownerId > 0 ? ownerId : 0,
    owner_id: Number.isFinite(ownerId) && ownerId > 0 ? ownerId : 0,
    ring_active: freshness.ringActive,
    ringActive: freshness.ringActive,
    ring_until: freshness.ringUntil,
    ringUntil: freshness.ringUntil,
    is_new: freshness.isNew,
    isNew: freshness.isNew,
    new_until: freshness.newUntil,
    newUntil: freshness.newUntil,
    reel: normalizedReel,
  };
};

const resolveReelResourceId = (responsePayload: any): string | number | null => {
  const id =
    Number(responsePayload?.body?.reel?.id ?? 0) ||
    Number(responsePayload?.body?.id ?? 0);
  return Number.isFinite(id) && id > 0 ? id : null;
};

export const create_reel = async (req: Request, res: Response) => {
  try {
    let video_uid = String(
      (req.body as any)?.video_uid ??
        (req.body as any)?.videoUid ??
        (req.body as any)?.uid ??
        ""
    ).trim();
    const image_id = String(
      (req.body as any)?.image_id ??
        (req.body as any)?.imageId ??
        (req.body as any)?.media_id ??
        ""
    ).trim();

    const requestedMediaType = String(
      (req.body as any)?.media_type ?? (req.body as any)?.mediaType ?? ""
    ).trim().toLowerCase();

    const streamFromBody = String(
      (req.body as any)?.stream_url ?? (req.body as any)?.streamUrl ?? ""
    ).trim();
    const imageUrlFromBody = normalizeImageVariantUrl(
      (req.body as any)?.image_url ??
        (req.body as any)?.imageUrl ??
        (req.body as any)?.media_url ??
        (req.body as any)?.mediaUrl ??
        ""
    );

    const inferredImageMode =
      requestedMediaType === 'image' ||
      (!!image_id && !video_uid && !streamFromBody) ||
      imageUrlFromBody.includes('/api/v1/media/image/play') ||
      imageUrlFromBody.includes('imagedelivery.net');

    const shouldPreferDefaultStream =
      !inferredImageMode &&
      Boolean(video_uid) &&
      (!streamFromBody || streamFromBody.startsWith("/api/v1/media/video/play"));

    const imagePlaybackPath = buildImagePlaybackPath(image_id);
    const resolvedImageUrl = imageUrlFromBody || imagePlaybackPath;
    let stream_url = inferredImageMode
      ? resolvedImageUrl
      : shouldPreferDefaultStream
      ? buildDefaultStreamUrl(video_uid)
      : streamFromBody || buildDefaultStreamUrl(video_uid);

    if (!stream_url) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: inferredImageMode
          ? "image_url or image_id is required"
          : "stream_url or video_uid is required",
      });
    }

    let thumbnail_url = String(
      (req.body as any)?.thumbnail_url ??
        (req.body as any)?.thumbnailUrl ??
        (inferredImageMode
          ? resolvedImageUrl
          : video_uid
          ? buildDefaultThumbnailUrl(video_uid, stream_url)
          : "")
    ).trim();

    const download_url = String(
      (req.body as any)?.download_url ??
        (req.body as any)?.downloadUrl ??
        (inferredImageMode
          ? resolvedImageUrl
          : video_uid
          ? `/api/v1/media/video/download?uid=${encodeURIComponent(video_uid)}`
          : "")
    ).trim();

    const duration_seconds = inferredImageMode
      ? 0
      : Math.max(
          0,
          Number((req.body as any)?.duration_seconds ?? (req.body as any)?.durationSeconds ?? 0) || 0
        );

    if (!inferredImageMode) {
      const normalizedUid = normalizeVideoUid(video_uid);
      if (!normalizedUid) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "video_uid is invalid",
        });
      }
      video_uid = normalizedUid;

      if (REEL_ENFORCE_STREAM_ASSET_READY) {
        const lookup = await readCloudflareStreamLookup(video_uid);
        if (!lookup.ok) {
          return formatResponse({
            res,
            success: false,
            code: 502,
            message: "video provider validation unavailable, retry",
            body: {
              video_uid,
              reason: lookup.reason ?? "provider_unavailable",
            },
          });
        }
        if (!lookup.exists) {
          return formatResponse({
            res,
            success: false,
            code: 409,
            message: "video upload not found, please upload again",
            body: {
              video_uid,
              state: lookup.state ?? "not_found",
            },
          });
        }
        if (!lookup.ready) {
          return formatResponse({
            res,
            success: false,
            code: 409,
            message: "video is still processing, try again in a moment",
            body: {
              video_uid,
              state: lookup.state ?? "processing",
            },
          });
        }
        stream_url = String(lookup.streamUrl ?? stream_url ?? "").trim() || stream_url;
        thumbnail_url =
          String(lookup.thumbnailUrl ?? thumbnail_url ?? "").trim() || thumbnail_url;
      }
    }

    const streamProfile =
      !inferredImageMode &&
      REEL_VALIDATE_STREAM_VARIANTS &&
      /^https?:\/\/.+\.m3u8($|\?)/i.test(stream_url)
        ? await inspectReelHlsManifestProfile(stream_url)
        : null;

    const safeStartupByFps =
      streamProfile == null ||
      streamProfile.variantCount === 0 ||
      streamProfile.safeVariantCount > 0;
    const safeStartupByBitrate =
      streamProfile == null ||
      streamProfile.variantCount === 0 ||
      streamProfile.safeMinBandwidthVariantCount > 0;
    const safeStartupByManifest = safeStartupByFps && safeStartupByBitrate;

    const unsafeStartupFpsDetected =
      !inferredImageMode &&
      streamProfile != null &&
      streamProfile.variantCount > 0 &&
      streamProfile.safeVariantCount <= 0;
    const unsafeStartupBitrateDetected =
      !inferredImageMode &&
      streamProfile != null &&
      streamProfile.variantCount > 0 &&
      streamProfile.safeMinBandwidthVariantCount <= 0;

    if (
      unsafeStartupFpsDetected &&
      REEL_ENFORCE_SAFE_STREAM_VARIANTS &&
      !REEL_ALLOW_UNSAFE_STREAM_VARIANTS
    ) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message:
          "Video no compatible para startup seguro (<=30fps). Reexporta en 30fps y vuelve a subir.",
      });
    }

    if (
      unsafeStartupFpsDetected &&
      REEL_ENFORCE_SAFE_STREAM_VARIANTS &&
      REEL_ALLOW_UNSAFE_STREAM_VARIANTS
    ) {
      console.warn(
        `[reel/create] allowing unsafe startup variants userId=${Number(req.userId ?? 0) || 0} videoUid=${video_uid || "n/a"} streamUrl=${stream_url}`
      );
    }

    if (
      unsafeStartupBitrateDetected &&
      REEL_ENFORCE_SAFE_STREAM_MIN_BITRATE &&
      !REEL_ALLOW_UNSAFE_STREAM_MIN_BITRATE
    ) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `Video no compatible para startup seguro (min bitrate <= ${Math.round(
          REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH / 1000
        )} kbps). Comprime el video y vuelve a subir.`,
      });
    }

    if (
      unsafeStartupBitrateDetected &&
      REEL_ENFORCE_SAFE_STREAM_MIN_BITRATE &&
      REEL_ALLOW_UNSAFE_STREAM_MIN_BITRATE
    ) {
      console.warn(
        `[reel/create] allowing unsafe startup bitrate userId=${Number(req.userId ?? 0) || 0} videoUid=${video_uid || "n/a"} minBandwidth=${streamProfile?.minBandwidth ?? "n/a"} threshold=${REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH}`
      );
    }

    const rawMetadata = parseJSON((req.body as any)?.metadata) ?? {};
    const metadata = {
      ...(rawMetadata && typeof rawMetadata === 'object' ? rawMetadata : {}),
      media_type: inferredImageMode ? 'image' : 'video',
      mediaType: inferredImageMode ? 'image' : 'video',
      image_id: inferredImageMode ? image_id || null : null,
      imageId: inferredImageMode ? image_id || null : null,
      image_url: inferredImageMode ? resolvedImageUrl || null : null,
      imageUrl: inferredImageMode ? resolvedImageUrl || null : null,
      stream_profile: !inferredImageMode
        ? {
            startup_safe_max_fps: REEL_STARTUP_SAFE_MAX_FPS,
            startup_safe_max_min_bandwidth: REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH,
            startup_safe: safeStartupByManifest,
            checked_at: streamProfile?.inspectedAt ?? null,
            variant_count: streamProfile?.variantCount ?? null,
            safe_variant_count: streamProfile?.safeVariantCount ?? null,
            safe_min_bandwidth_variant_count:
              streamProfile?.safeMinBandwidthVariantCount ?? null,
            min_bandwidth: streamProfile?.minBandwidth ?? null,
            max_bandwidth: streamProfile?.maxBandwidth ?? null,
            max_frame_rate: streamProfile?.maxFrameRate ?? null,
            has_unsafe_frame_rate: streamProfile?.hasUnsafeFrameRate ?? null,
            has_unsafe_min_bandwidth: streamProfile?.hasUnsafeMinBandwidth ?? null,
            check_error: streamProfile?.checkError ?? null,
          }
        : null,
      streamProfile: !inferredImageMode
        ? {
            startupSafeMaxFps: REEL_STARTUP_SAFE_MAX_FPS,
            startupSafeMaxMinBandwidth: REEL_STARTUP_SAFE_MAX_MIN_BANDWIDTH,
            startupSafe: safeStartupByManifest,
            checkedAt: streamProfile?.inspectedAt ?? null,
            variantCount: streamProfile?.variantCount ?? null,
            safeVariantCount: streamProfile?.safeVariantCount ?? null,
            safeMinBandwidthVariantCount:
              streamProfile?.safeMinBandwidthVariantCount ?? null,
            minBandwidth: streamProfile?.minBandwidth ?? null,
            maxBandwidth: streamProfile?.maxBandwidth ?? null,
            maxFrameRate: streamProfile?.maxFrameRate ?? null,
            hasUnsafeFrameRate: streamProfile?.hasUnsafeFrameRate ?? null,
            hasUnsafeMinBandwidth: streamProfile?.hasUnsafeMinBandwidth ?? null,
            checkError: streamProfile?.checkError ?? null,
          }
        : null,
    };

    const payload = {
      userId: req.userId,
      description: String((req.body as any)?.description ?? "").trim() || null,
      hashtags: (req.body as any)?.hashtags,
      video_uid: inferredImageMode ? null : video_uid || null,
      stream_url,
      download_url: download_url || null,
      thumbnail_url: thumbnail_url || null,
      duration_seconds,
      visibility: parseVisibility((req.body as any)?.visibility),
      status: String((req.body as any)?.status ?? "ready").toLowerCase() === "processing"
        ? "processing"
        : String((req.body as any)?.status ?? "ready").toLowerCase() === "failed"
        ? "failed"
        : "ready",
      allow_download: parseBool((req.body as any)?.allow_download ?? (req.body as any)?.allowDownload, true),
      metadata,
      is_delete: false,
    };

    const canProceed = await applyCreateContentIdempotency({
      req,
      res,
      endpoint: "/api/v1/reel",
      payloadForHash: payload,
      resolveResourceId: resolveReelResourceId,
    });
    if (!canProceed) return;

    const createdReel = await repository.createReel(payload);
    const hydratedReel =
      (await repository.getById((createdReel as any)?.id, req.userId)) ??
      toPlainObject(createdReel);

    const realtimePayload = buildReelRealtimePayload(
      "created",
      hydratedReel,
      req.userId
    );
    if (realtimePayload) {
      socket.emit("reel/created", realtimePayload);
    }

    const ownerRingState = await getActiveOrbitStateByUser({
      userIdRaw: req.userId,
      viewerIdRaw: req.userId,
    });
    const ringSnapshot = {
      has_active_orbit: ownerRingState.hasActiveOrbit,
      hasActiveOrbit: ownerRingState.hasActiveOrbit,
      has_orbit_ring: ownerRingState.hasActiveOrbit,
      hasOrbitRing: ownerRingState.hasActiveOrbit,
      active_orbit_reel_id: ownerRingState.activeOrbitReelId,
      activeOrbitReelId: ownerRingState.activeOrbitReelId,
      orbit_ring_until: ownerRingState.orbitRingUntil,
      orbitRingUntil: ownerRingState.orbitRingUntil,
    };
    emitOrbitRingUpdatedRealtime({
      action: "updated",
      user_id: Number(req.userId ?? 0) || 0,
      userId: Number(req.userId ?? 0) || 0,
      ...ringSnapshot,
      user: {
        id: Number(req.userId ?? 0) || 0,
        userId: Number(req.userId ?? 0) || 0,
        user_id: Number(req.userId ?? 0) || 0,
        ...ringSnapshot,
      },
    });

    await bumpHomeContentSectionVersion("reels");

    if (!inferredImageMode && video_uid) {
      const warmupUserId = Number(req.userId ?? 0) || 0;
      const warmupStreamUrl =
        String((hydratedReel as any)?.stream_url ?? stream_url ?? "").trim() || null;
      const warmupThumbUrl =
        String((hydratedReel as any)?.thumbnail_url ?? thumbnail_url ?? "").trim() || null;
      const warmupOffsetsMs = parseWarmupDelayOffsetsMs();
      let warmupSucceeded = false;
      for (const offsetMs of warmupOffsetsMs) {
        setTimeout(() => {
          if (warmupSucceeded) return;
          void warmUpReelStreamAssets({
            userId: warmupUserId,
            videoUid: video_uid,
            streamUrl: warmupStreamUrl,
            thumbnailUrl: warmupThumbUrl,
            phase: `t+${offsetMs}ms`,
          }).then((ok) => {
            if (ok) warmupSucceeded = true;
          });
        }, offsetMs);
      }
    }

    return formatResponse({
      res,
      success: true,
      body: { reel: realtimePayload?.reel ?? hydratedReel },
    });
  } catch (error) {
    if (isHashtagValidationError(error)) {
      return sendHashtagError(
        res,
        error.status ?? 400,
        error.code,
        error.message
      );
    }
    return formatResponse({ res, success: false, message: error });
  }
};

export const add_reel_comment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const commentText = String((req.body as any)?.comment ?? "").trim();
    const media_url = String((req.body as any)?.media_url ?? "").trim() || null;

    if (!commentText && !media_url) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "comment or media_url is required",
      });
    }

    const result = await repository.addComment(id, req.userId, {
      comment: commentText || null,
      media_url,
      hashtags: (req.body as any)?.hashtags,
    });

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    const reelId = Number(id);
    const ownerUserId = Number((result as any)?.reelUserId ?? 0);
    const actorUserId = Number(req.userId ?? 0);
    if (ownerUserId > 0 && ownerUserId !== actorUserId) {
      const rawPreview = commentText;
      const snippet = rawPreview.length > 60 ? `${rawPreview.slice(0, 60)}...` : rawPreview;
      const notificationBody = snippet || "Has commented on your Orbit.";

      try {
        await sendNotification({
          userId: ownerUserId,
          interactorId: actorUserId,
          reelId,
          commentId: Number((result as any)?.comment?.id ?? 0) || undefined,
          type: "comment",
          message: notificationBody,
          deeplink: `orbit/${reelId}`,
        });
      } catch (notifyError) {
        console.error(
          `[reel_comment] notification failed ownerId=${ownerUserId} interactorId=${actorUserId} reelId=${id}`,
          notifyError
        );
      }
    }

    const commentPayload = normalizeReelCommentPayload((result as any)?.comment ?? null);
    const realtimePayload = {
      action: "commented",
      reelId,
      reel_id: reelId,
      ownerId: ownerUserId,
      owner_id: ownerUserId,
      actorUserId,
      actor_user_id: actorUserId,
      comments_count: Number((result as any)?.comments_count ?? 0),
      commentsCount: Number((result as any)?.comments_count ?? 0),
      comment: commentPayload,
      commentCreatedAt: commentPayload?.createdAt ?? null,
      comment_created_at: commentPayload?.created_at ?? null,
    };
    socket.emit("reel/commented", realtimePayload);
    const updatedReel = await repository.getById(reelId, req.userId);
    const updatedAt = new Date().toISOString();
    const updatedReelPayload =
      updatedReel ??
      {
        id: reelId,
        comments_count: Number((result as any)?.comments_count ?? 0),
        commentsCount: Number((result as any)?.comments_count ?? 0),
      };
    socket.emit("reel/updated", {
      action: "commented",
      reelId,
      reel_id: reelId,
      ownerId: ownerUserId,
      owner_id: ownerUserId,
      actorUserId,
      actor_user_id: actorUserId,
      comments_count: Number((result as any)?.comments_count ?? 0),
      commentsCount: Number((result as any)?.comments_count ?? 0),
      updatedAt,
      updated_at: updatedAt,
      reel: updatedReelPayload,
      comment: commentPayload,
    });

    return formatResponse({
      res,
      success: true,
      body: {
        comment: commentPayload,
        comments_count: result.comments_count,
        commentsCount: result.comments_count,
      },
    });
  } catch (error) {
    if (isHashtagValidationError(error)) {
      return sendHashtagError(
        res,
        error.status ?? 400,
        error.code,
        error.message
      );
    }
    return formatResponse({ res, success: false, message: error });
  }
};
