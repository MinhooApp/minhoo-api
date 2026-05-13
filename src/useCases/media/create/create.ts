import {
  Request,
  Response,
  formatResponse,
  axios,
} from "../_module/module";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import multer from "multer";
import { promises as fs } from "fs";
import path from "path";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const IS_PRODUCTION =
  String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_RESOLUTION = 2048;
const IMAGE_FEED_WIDTH = 1080;
const IMAGE_OUTPUT_FORMAT = "webp";
const IMAGE_OUTPUT_QUALITY = 80;
const IMAGE_UPLOAD_TTL_SECONDS = 60 * 15;
const IMAGE_PLAY_TTL_SECONDS = 60 * 10;
const IMAGE_R2_KEY_PREFIX =
  String(process.env.CLOUDFLARE_R2_IMAGE_PREFIX ?? "r2img")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "") || "r2img";
const LOCAL_IMAGE_FALLBACK_ENABLED =
  String(process.env.LOCAL_IMAGE_FALLBACK_ENABLED ?? "1").trim() !== "0";
const LOCAL_IMAGE_FALLBACK_DIR_RAW = String(
  process.env.LOCAL_IMAGE_FALLBACK_DIR ?? "/home/appuser/minhoo-image-fallback"
).trim();
const LOCAL_IMAGE_FALLBACK_DIR =
  !LOCAL_IMAGE_FALLBACK_DIR_RAW ||
  LOCAL_IMAGE_FALLBACK_DIR_RAW === "/tmp" ||
  LOCAL_IMAGE_FALLBACK_DIR_RAW.startsWith("/tmp/")
    ? "/home/appuser/minhoo-image-fallback"
    : LOCAL_IMAGE_FALLBACK_DIR_RAW;
const uploadImageFallback = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES },
});
const IMAGE_PLAYBACK_REDIRECT_TTL_SECONDS = Math.max(
  30,
  Number(process.env.IMAGE_PLAYBACK_REDIRECT_TTL_SECONDS ?? 300) || 300
);
const IMAGE_PLAYBACK_REDIRECT_CACHE_TTL_MS = IMAGE_PLAYBACK_REDIRECT_TTL_SECONDS * 1000;
const IMAGE_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS = Math.max(
  100,
  Number(process.env.IMAGE_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS ?? 5000) || 5000
);
const VIDEO_PLAYBACK_REDIRECT_TTL_SECONDS = Math.max(
  30,
  Number(process.env.VIDEO_PLAYBACK_REDIRECT_TTL_SECONDS ?? 300) || 300
);
const VIDEO_PLAYBACK_REDIRECT_CACHE_TTL_MS = VIDEO_PLAYBACK_REDIRECT_TTL_SECONDS * 1000;
const VIDEO_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS = Math.max(
  100,
  Number(process.env.VIDEO_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS ?? 5000) || 5000
);

const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const VIDEO_MAX_DURATION_SECONDS = 180;
const VIDEO_OUTPUT_RESOLUTION = "720p";
const VIDEO_OUTPUT_CODEC = "H.264 MP4";
const VIDEO_STREAMING = "HLS";
const VIDEO_R2_STREAMING = "Progressive MP4";
const CLOUDFLARE_VIDEO_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.CLOUDFLARE_VIDEO_HTTP_TIMEOUT_MS ?? 20000) || 20000
);
const CLOUDFLARE_IMAGE_CONFIRM_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.CLOUDFLARE_IMAGE_CONFIRM_TIMEOUT_MS ?? 1200) || 1200
);
const VIDEO_PENDINGUPLOAD_STALE_SECONDS = Math.max(
  10,
  Number(process.env.VIDEO_PENDINGUPLOAD_STALE_SECONDS ?? 20) || 20
);
const VIDEO_CONFIRM_READY_CACHE_TTL_MS = Math.max(
  5000,
  Number(process.env.VIDEO_CONFIRM_READY_CACHE_TTL_MS ?? 60000) || 60000
);
const VIDEO_CONFIRM_PENDING_CACHE_TTL_MS = Math.max(
  500,
  Number(process.env.VIDEO_CONFIRM_PENDING_CACHE_TTL_MS ?? 1500) || 1500
);
const VIDEO_CONFIRM_CACHE_MAX_ITEMS = Math.max(
  100,
  Number(process.env.VIDEO_CONFIRM_CACHE_MAX_ITEMS ?? 10000) || 10000
);
const VIDEO_DOWNLOAD_STREAM_MODE = String(
  process.env.VIDEO_DOWNLOAD_STREAM_MODE ?? "redirect"
)
  .trim()
  .toLowerCase();
const VIDEO_DOWNLOAD_SHOULD_PROXY = VIDEO_DOWNLOAD_STREAM_MODE === "proxy";

const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
const AUDIO_MAX_DURATION_SECONDS = 60;
const AUDIO_OUTPUT_CODEC = "AAC / OPUS";
const AUDIO_STREAMING = "HLS";
const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const DOCUMENT_ALLOWED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/zip",
  "application/x-rar-compressed",
  "application/octet-stream",
  "text/plain",
  "text/csv",
]);

const isAllowedDocumentContentType = (contentType: string) => {
  const normalized = contentType.trim().toLowerCase();
  if (!normalized) return false;
  if (DOCUMENT_ALLOWED_MIME_TYPES.has(normalized)) return true;
  return normalized.startsWith("text/");
};

const parsePositiveInt = (value: any): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
};

const parseCsv = (value: any): string[] => {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

type ModerationCategory = "sexual" | "violence" | "alcohol" | "tobacco";

type ModerationDecision = {
  blocked: boolean;
  categories: ModerationCategory[];
  rawSignals: string[];
};

type ModerationAssetType = "image" | "video";

const MODERATION_CATEGORY_KEYWORDS: Record<ModerationCategory, string[]> = {
  sexual: [
    "sexual",
    "sex",
    "nudity",
    "nude",
    "porn",
    "explicit",
    "nsfw",
    "adult",
  ],
  violence: [
    "violence",
    "violent",
    "gore",
    "blood",
    "graphic",
    "weapon",
    "fight",
  ],
  alcohol: [
    "alcohol",
    "beer",
    "wine",
    "vodka",
    "whisky",
    "liquor",
    "drunk",
  ],
  tobacco: [
    "tobacco",
    "cigarette",
    "cigar",
    "smoke",
    "smoking",
    "vape",
    "nicotine",
  ],
};

const isTruthyLike = (value: any): boolean => {
  if (value === true || value === 1) return true;
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y";
};

const prefersSpanishLocale = (req: Request): boolean => {
  const candidates = [
    req.header("x-language"),
    req.header("x-lang"),
    req.header("x-locale"),
    req.header("accept-language"),
    (req.body as any)?.language,
    (req.body as any)?.lang,
    (req.body as any)?.locale,
  ];
  const raw = candidates
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find((value) => Boolean(value));
  return Boolean(raw && raw.startsWith("es"));
};

const normalizeModerationSignals = (value: any): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return [];
    return normalized
      .split(/[,\s;|]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([, flag]) => isTruthyLike(flag))
      .map(([key]) => String(key).trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
};

const detectModerationCategories = (signals: string[]): ModerationCategory[] => {
  const categories: ModerationCategory[] = [];
  (Object.keys(MODERATION_CATEGORY_KEYWORDS) as ModerationCategory[]).forEach((category) => {
    const hit = signals.some((signal) =>
      MODERATION_CATEGORY_KEYWORDS[category].some((keyword) => signal.includes(keyword))
    );
    if (hit) categories.push(category);
  });
  return categories;
};

const normalizeModerationAssetType = (value: any): ModerationAssetType | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!normalized) return null;
  if (normalized === "image" || normalized === "photo" || normalized === "img") return "image";
  if (normalized === "video" || normalized === "stream") return "video";
  return null;
};

const normalizeModerationDecisionFromObject = (raw: any): ModerationDecision => {
  const payload = raw ?? {};
  const sources = [
    payload,
    payload?.moderation,
    payload?.data,
    payload?.data?.moderation,
    payload?.result,
    payload?.result?.moderation,
    payload?.output,
    payload?.analysis,
    payload?.classification,
  ].filter(Boolean);

  const rawSignals = Array.from(
    new Set(
      sources.flatMap((source: any) => [
        ...normalizeModerationSignals(source?.moderation_categories),
        ...normalizeModerationSignals(source?.moderation_labels),
        ...normalizeModerationSignals(source?.moderation_hazards),
        ...normalizeModerationSignals(source?.blocked_categories),
        ...normalizeModerationSignals(source?.categories),
        ...normalizeModerationSignals(source?.labels),
        ...normalizeModerationSignals(source?.hazards),
        ...normalizeModerationSignals(source?.violations),
        ...normalizeModerationSignals(source?.classes),
      ])
    )
  );

  const categories = detectModerationCategories(rawSignals);
  const explicitlyBlocked = sources.some(
    (source: any) =>
      isTruthyLike(source?.blocked) ||
      isTruthyLike(source?.is_blocked) ||
      isTruthyLike(source?.moderation_blocked) ||
      isTruthyLike(source?.blocked_content) ||
      isTruthyLike(source?.unsafe)
  );

  return {
    blocked: explicitlyBlocked || categories.length > 0,
    categories,
    rawSignals,
  };
};

const buildModerationConfirmPayload = (decision: ModerationDecision) => ({
  moderation_blocked: decision.blocked,
  moderation_categories: decision.categories,
});

const resolveModerationDecision = (req: Request): ModerationDecision => {
  const body = (req.body as any) ?? {};
  return normalizeModerationDecisionFromObject(body);
};

const buildModerationBlockedMessage = (req: Request, categories: ModerationCategory[]) => {
  const isSpanish = prefersSpanishLocale(req);
  if (isSpanish) {
    if (categories.length === 1 && categories[0] === "sexual") {
      return "No tenemos permitido publicar contenido sexual explícito en Minhoo.";
    }
    if (categories.length === 1 && categories[0] === "violence") {
      return "No tenemos permitido publicar contenido violento o gráfico en Minhoo.";
    }
    if (categories.length === 1 && categories[0] === "alcohol") {
      return "No tenemos permitido publicar contenido relacionado con alcohol en Minhoo.";
    }
    if (categories.length === 1 && categories[0] === "tobacco") {
      return "No tenemos permitido publicar contenido relacionado con tabaco en Minhoo.";
    }
    return "No tenemos permitido este tipo de contenido en Minhoo. Evita contenido sexual, violento o relacionado con alcohol o tabaco.";
  }

  if (categories.length === 1 && categories[0] === "sexual") {
    return "Explicit sexual content is not allowed on Minhoo.";
  }
  if (categories.length === 1 && categories[0] === "violence") {
    return "Violent or graphic content is not allowed on Minhoo.";
  }
  if (categories.length === 1 && categories[0] === "alcohol") {
    return "Alcohol-related content is not allowed on Minhoo.";
  }
  if (categories.length === 1 && categories[0] === "tobacco") {
    return "Tobacco-related content is not allowed on Minhoo.";
  }
  return "This type of content is not allowed on Minhoo. Please avoid sexual, violent, alcohol-related, or tobacco-related content.";
};

const respondModerationBlocked = ({
  req,
  res,
  assetType,
  decision,
}: {
  req: Request;
  res: Response;
  assetType: "image" | "video";
  decision: ModerationDecision;
}) =>
  formatResponse({
    res,
    success: false,
    islogin: true,
    code: 422,
    message: buildModerationBlockedMessage(req, decision.categories),
    body: {
      moderation: {
        blocked: true,
        code: "MEDIA_BLOCKED_CONTENT_POLICY",
        asset_type: assetType,
        categories: decision.categories,
        signals: decision.rawSignals,
      },
    },
  });

const getModerationProviderUrl = () =>
  String(
    process.env.MEDIA_MODERATION_PROVIDER_URL ??
      process.env.CLOUDFLARE_MODERATION_WORKER_URL ??
      ""
  ).trim();

const getModerationProviderToken = () =>
  String(
    process.env.MEDIA_MODERATION_PROVIDER_TOKEN ??
      process.env.CLOUDFLARE_MODERATION_WORKER_TOKEN ??
      ""
  ).trim();

const getModerationProviderTimeoutMs = () => {
  const parsed = Number(process.env.MEDIA_MODERATION_PROVIDER_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(parsed) || parsed < 1000) return 15000;
  return Math.floor(parsed);
};

const shouldAutoBlockTobacco = (): boolean => {
  const configured = process.env.MEDIA_MODERATION_AUTOBLOCK_TOBACCO;
  if (configured === undefined) return false;
  return isTruthyLike(configured);
};

const TOBACCO_SIGNAL_KEYWORDS = [
  "tobacco",
  "cigarette",
  "cigar",
  "smoke",
  "smoking",
  "vape",
  "nicotine",
];

const isTobaccoSignal = (signal: string): boolean =>
  TOBACCO_SIGNAL_KEYWORDS.some((keyword) => signal.includes(keyword));

const shouldTrustTobaccoSignal = (): boolean => {
  const configured = process.env.MEDIA_MODERATION_TRUST_TOBACCO_SIGNAL;
  if (configured === undefined) return false;
  return isTruthyLike(configured);
};

const safeParseJsonObject = (value: any): Record<string, any> | null => {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
};

const applyModerationProviderGuards = (
  providerPayload: any,
  decision: ModerationDecision
): ModerationDecision => {
  const moderationNode =
    providerPayload?.data?.moderation ??
    providerPayload?.moderation ??
    providerPayload?.result?.moderation ??
    providerPayload?.output?.moderation ??
    null;

  if (!moderationNode || typeof moderationNode !== "object") return decision;
  if (shouldTrustTobaccoSignal()) return decision;

  const categories = Array.isArray(moderationNode?.categories)
    ? moderationNode.categories.map((entry: any) => String(entry ?? "").trim().toLowerCase())
    : [];
  const onlyTobaccoCategory =
    categories.length === 1 && categories[0] === "tobacco" && decision.categories.length === 1;

  if (!onlyTobaccoCategory) return decision;

  const baseRaw = safeParseJsonObject(moderationNode?.raw_response);
  const baseBlocked = isTruthyLike(baseRaw?.blocked);
  const baseCategories = normalizeModerationSignals(baseRaw?.categories);
  const baseLabels = normalizeModerationSignals(baseRaw?.labels);
  const baseHasViolation = baseBlocked || baseCategories.length > 0 || baseLabels.length > 0;

  const tobaccoSignal = moderationNode?.tobacco_signal ?? {};
  const tobaccoPresent = isTruthyLike(tobaccoSignal?.tobacco_present);
  const tobaccoConfidence = Number(tobaccoSignal?.confidence ?? 0);
  const confidenceIsLow = !Number.isFinite(tobaccoConfidence) || tobaccoConfidence <= 0.8;

  if (!baseHasViolation && tobaccoPresent && confidenceIsLow) {
    const filteredSignals = decision.rawSignals.filter(
      (signal) => !signal.includes("tobacco") && !signal.includes("cigarette")
    );
    return {
      blocked: false,
      categories: [],
      rawSignals: filteredSignals,
    };
  }

  return decision;
};

const applyModerationBlockingPolicy = (decision: ModerationDecision): ModerationDecision => {
  if (shouldAutoBlockTobacco()) return decision;

  const categoriesWithoutTobacco = decision.categories.filter((category) => category !== "tobacco");
  const hasTobaccoCategory = decision.categories.includes("tobacco");
  const hasOnlyTobaccoSignals =
    decision.rawSignals.length > 0 && decision.rawSignals.every(isTobaccoSignal);

  // Temporary policy for QA: do not auto-block tobacco-only detections.
  if (hasTobaccoCategory && categoriesWithoutTobacco.length === 0) {
    return {
      blocked: false,
      categories: [],
      rawSignals: decision.rawSignals.filter((signal) => !isTobaccoSignal(signal)),
    };
  }

  if (!hasTobaccoCategory && hasOnlyTobaccoSignals) {
    return {
      blocked: false,
      categories: [],
      rawSignals: [],
    };
  }

  return {
    blocked: categoriesWithoutTobacco.length > 0 ? true : decision.blocked,
    categories: categoriesWithoutTobacco,
    rawSignals: decision.rawSignals,
  };
};

const shouldEnforceModerationAtConfirm = (context: string): boolean => {
  const configured = process.env.MEDIA_MODERATION_ENFORCE_AT_CONFIRM;
  const enforceByDefault = IS_PRODUCTION;
  const enforce = configured === undefined ? enforceByDefault : isTruthyLike(configured);
  if (!enforce) return false;

  const contextsRaw = String(
    process.env.MEDIA_MODERATION_ENFORCE_CONTEXTS ?? "feed,post,reel,public"
  )
    .trim()
    .toLowerCase();

  if (!contextsRaw) return true;
  const contexts = new Set(
    contextsRaw
      .split(/[,\s;|]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  if (!contexts.size) return true;
  return contexts.has(context);
};

type ModerationProviderResult =
  | {
      ok: true;
      decision: ModerationDecision;
    }
  | {
      ok: false;
      code: number;
      message: string;
    };

const fetchModerationDecisionFromProvider = async ({
  req,
  assetType,
  imageId,
  videoUid,
  context,
}: {
  req: Request;
  assetType: ModerationAssetType;
  imageId?: string | null;
  videoUid?: string | null;
  context: string;
}): Promise<ModerationProviderResult> => {
  const providerUrl = getModerationProviderUrl();
  if (!providerUrl) {
    return {
      ok: false,
      code: 503,
      message:
        "MEDIA_MODERATION_PROVIDER_URL is not configured. Unable to moderate media before confirm.",
    };
  }

  const mediaPath =
    assetType === "image" && imageId
      ? buildImagePlaybackPath(imageId)
      : buildVideoPlaybackPath(String(videoUid ?? ""));
  const requestOrigin = resolveRequestOrigin(req);
  const mediaUrl = requestOrigin ? `${requestOrigin}${mediaPath}` : mediaPath;
  const payload = {
    asset_type: assetType,
    image_id: imageId ?? null,
    video_uid: videoUid ?? null,
    media_path: mediaPath,
    media_url: mediaUrl,
    user_id: req.userId ?? null,
    context: normalizeMediaContext(context),
    locale:
      String(
        (req.body as any)?.locale ??
          (req.body as any)?.lang ??
          (req.body as any)?.language ??
          req.header("accept-language") ??
          ""
      )
        .trim()
        .slice(0, 20) || null,
  };

  const token = getModerationProviderToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await axios.post(providerUrl, payload, {
      headers,
      timeout: getModerationProviderTimeoutMs(),
    });
    const providerPayload = response?.data ?? {};
    const normalizedDecision = normalizeModerationDecisionFromObject(providerPayload);
    const guardedDecision = applyModerationProviderGuards(providerPayload, normalizedDecision);
    return {
      ok: true,
      decision: applyModerationBlockingPolicy(guardedDecision),
    };
  } catch (error: any) {
    const providerMessage =
      String(
        error?.response?.data?.message ??
          error?.response?.data?.error ??
          error?.message ??
          "moderation provider request failed"
      ).trim() || "moderation provider request failed";

    return {
      ok: false,
      code: 502,
      message: providerMessage,
    };
  }
};

const resolveConfirmModerationDecision = async ({
  req,
  assetType,
  imageId,
  videoUid,
}: {
  req: Request;
  assetType: ModerationAssetType;
  imageId?: string | null;
  videoUid?: string | null;
}): Promise<ModerationProviderResult> => {
  const context = normalizeMediaContext((req.body as any)?.context ?? "feed");
  const clientDecision = resolveModerationDecision(req);

  if (!shouldEnforceModerationAtConfirm(context)) {
    return { ok: true, decision: applyModerationBlockingPolicy(clientDecision) };
  }

  const providerResult = await fetchModerationDecisionFromProvider({
    req,
    assetType,
    imageId: imageId ?? null,
    videoUid: videoUid ?? null,
    context,
  });
  if (!providerResult.ok) return providerResult;

  const categories = Array.from(
    new Set([...providerResult.decision.categories, ...clientDecision.categories])
  ) as ModerationCategory[];
  const rawSignals = Array.from(
    new Set([...providerResult.decision.rawSignals, ...clientDecision.rawSignals])
  );
  const mergedDecision = applyModerationBlockingPolicy({
    blocked:
      providerResult.decision.blocked ||
      clientDecision.blocked ||
      categories.length > 0,
    categories,
    rawSignals,
  });

  return {
    ok: true,
    decision: mergedDecision,
  };
};

const getCloudflareAccountId = () =>
  String(process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();

const getImagesToken = () =>
  String(
    process.env.CLOUDFLARE_IMAGES_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();

const getMediaToken = () =>
  String(
    process.env.CLOUDFLARE_MEDIA_API_TOKEN ??
      process.env.CLOUDFLARE_API_TOKEN ??
      process.env.CLOUDFLARE_TOKEN ??
      ""
  ).trim();


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

const getImageVariant = () =>
  String(process.env.CLOUDFLARE_IMAGES_VARIANT ?? "public").trim() || "public";

const isPublicImageVariant = () => getImageVariant().trim().toLowerCase() === "public";

const cloudflareHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const extractCloudflareError = (error: any) => {
  const errors = error?.response?.data?.errors;
  if (Array.isArray(errors) && errors.length) {
    const messages = errors
      .map((entry: any) => String(entry?.message ?? "").trim())
      .filter(Boolean);
    if (messages.length) return messages.join(" | ");
  }

  const message =
    error?.response?.data?.message ??
    error?.response?.statusText ??
    error?.message ??
    "cloudflare request failed";

  return String(message);
};

const isAxiosTimeoutError = (error: any) => {
  const code = String(error?.code ?? "").trim().toUpperCase();
  if (code === "ECONNABORTED") return true;
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("timeout");
};

const isCloudflareTransientError = (error: any) => {
  if (isAxiosTimeoutError(error)) return true;
  const status = Number(error?.response?.status ?? 0);
  if (status >= 500 || status === 429) return true;
  const code = String(error?.code ?? "").trim().toUpperCase();
  return (
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ETIMEDOUT"
  );
};

const isCloudflareAuthError = (error: any) => {
  const status = Number(error?.response?.status ?? error?.statusCode ?? 0);
  if (status === 401 || status === 403) return true;
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("authentication error") ||
    message.includes("invalid access token") ||
    message.includes("expired")
  );
};

const parseDateMs = (value: any): number | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return ms;
};

const ensureCloudflareConfig = (kind: "images" | "media") => {
  const accountId = getCloudflareAccountId();
  const token = kind === "images" ? getImagesToken() : getMediaToken();

  if (!accountId) {
    return {
      ok: false,
      message: "CLOUDFLARE_ACCOUNT_ID is not configured",
      accountId: "",
      token: "",
    };
  }
  if (!token) {
    const key =
      kind === "images"
        ? "CLOUDFLARE_IMAGES_API_TOKEN"
        : "CLOUDFLARE_MEDIA_API_TOKEN";
    return {
      ok: false,
      message: `${key} is not configured`,
      accountId,
      token: "",
    };
  }
  return { ok: true, message: "", accountId, token };
};

const R2_REGION = "auto";
const R2_SERVICE = "s3";
const VIDEO_UPLOAD_TTL_SECONDS = 60 * 15;
const VIDEO_PLAY_TTL_SECONDS = 60 * 10;
const VIDEO_DOWNLOAD_TTL_SECONDS = 60 * 10;
const AUDIO_UPLOAD_TTL_SECONDS = 60 * 15;
const AUDIO_PLAY_TTL_SECONDS = 60 * 10;
const DOCUMENT_UPLOAD_TTL_SECONDS = 60 * 15;
const DOCUMENT_DOWNLOAD_TTL_SECONDS = 60 * 10;
const MEDIA_ACCESS_TOKEN_QUERY_KEY = "sat";
const MEDIA_ACCESS_TOKEN_TTL_SECONDS = Math.max(
  30,
  Number(process.env.MEDIA_ACCESS_TOKEN_TTL_SECONDS ?? 10 * 60) || 10 * 60
);
const MEDIA_ACCESS_TOKEN_ENFORCE =
  String(process.env.MEDIA_ACCESS_TOKEN_ENFORCE ?? (IS_PRODUCTION ? "1" : "0"))
    .trim() === "1";
const MEDIA_ACCESS_ALLOW_PUBLIC_IMAGE_UNSIGNED =
  String(process.env.MEDIA_ACCESS_ALLOW_PUBLIC_IMAGE_UNSIGNED ?? "1").trim() === "1";

const getR2Bucket = () =>
  String(
    process.env.CLOUDFLARE_R2_BUCKET ??
      process.env.R2_BUCKET ??
      process.env.CLOUDFLARE_R2_AUDIO_BUCKET ??
      "static-minhoo"
  ).trim();

const getR2Endpoint = () => {
  const explicit = String(
    process.env.CLOUDFLARE_R2_ENDPOINT ??
      process.env.R2_ENDPOINT ??
      process.env.CLOUDFLARE_R2_S3_ENDPOINT ??
      process.env.R2_S3_ENDPOINT ??
      ""
  ).trim();
  if (explicit) return explicit;

  const accountId = getCloudflareAccountId();
  if (!accountId) return "";
  return `https://${accountId}.r2.cloudflarestorage.com`;
};

const getR2AccessKeyId = () =>
  String(
    process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ??
      process.env.R2_ACCESS_KEY_ID ??
      process.env.CLOUDFLARE_ACCESS_KEY_ID ??
      ""
  ).trim();

const getR2SecretAccessKey = () =>
  String(
    process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ??
      process.env.R2_SECRET_ACCESS_KEY ??
      process.env.CLOUDFLARE_SECRET_ACCESS_KEY ??
      ""
  ).trim();

const ensureR2Config = () => {
  const bucket = getR2Bucket();
  const endpoint = getR2Endpoint();
  const accessKeyId = getR2AccessKeyId();
  const secretAccessKey = getR2SecretAccessKey();

  if (!bucket) {
    return {
      ok: false,
      message: "CLOUDFLARE_R2_BUCKET is not configured",
      bucket: "",
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
    };
  }
  if (!endpoint) {
    return {
      ok: false,
      message: "CLOUDFLARE_R2_ENDPOINT is not configured",
      bucket,
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
    };
  }
  if (!accessKeyId) {
    return {
      ok: false,
      message: "CLOUDFLARE_R2_ACCESS_KEY_ID is not configured",
      bucket,
      endpoint,
      accessKeyId: "",
      secretAccessKey: "",
    };
  }
  if (!secretAccessKey) {
    return {
      ok: false,
      message: "CLOUDFLARE_R2_SECRET_ACCESS_KEY is not configured",
      bucket,
      endpoint,
      accessKeyId,
      secretAccessKey: "",
    };
  }

  return { ok: true, message: "", bucket, endpoint, accessKeyId, secretAccessKey };
};

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string) =>
  createHmac("sha256", key).update(value).digest();

const toAmzDate = (date: Date) =>
  date.toISOString().replace(/[:-]|\.\d{3}/g, "");

const buildR2ObjectUrl = (endpoint: string, bucket: string, key: string) => {
  const endpointUrl = new URL(
    /^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`
  );
  const basePath = endpointUrl.pathname.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => rfc3986(segment))
    .join("/");
  const host = endpointUrl.host.startsWith(`${bucket}.`)
    ? endpointUrl.host
    : `${bucket}.${endpointUrl.host}`;
  const objectPath = `${basePath}/${encodedKey}`.replace(/\/{2,}/g, "/");
  return {
    host,
    origin: `${endpointUrl.protocol}//${host}`,
    canonicalUri: objectPath.startsWith("/") ? objectPath : `/${objectPath}`,
  };
};

const buildR2PresignedUrl = ({
  method,
  bucket,
  endpoint,
  key,
  accessKeyId,
  secretAccessKey,
  expiresSeconds,
}: {
  method: "PUT" | "GET" | "HEAD" | "DELETE";
  bucket: string;
  endpoint: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
}) => {
  const operationIdByMethod: Record<"PUT" | "GET" | "HEAD" | "DELETE", string> = {
    PUT: "PutObject",
    GET: "GetObject",
    HEAD: "HeadObject",
    DELETE: "DeleteObject",
  };
  const { host, origin, canonicalUri } = buildR2ObjectUrl(endpoint, bucket, key);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.min(expiresSeconds, 604800))),
    "X-Amz-SignedHeaders": "host",
    "x-id": operationIdByMethod[method],
  };

  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, R2_REGION);
  const kService = hmac(kRegion, R2_SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

const normalizeObjectKey = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const decoded = decodeURIComponent(String(value).trim());
  if (!decoded) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(decoded)) return null;
  return decoded;
};
const normalizeVideoStorageKey = normalizeObjectKey;
const normalizeAudioKey = normalizeObjectKey;
const normalizeDocumentKey = normalizeObjectKey;

type SignedMediaKind =
  | "audio"
  | "document"
  | "video_key"
  | "video_uid"
  | "image_id"
  | "image_upload";

const getMediaAccessSigningSecret = () =>
  String(
    process.env.MEDIA_ACCESS_SIGNING_SECRET ??
      process.env.JWT_SECRET ??
      process.env.SECRETORPRIVATEKEY ??
      ""
  ).trim();

const hasMediaAccessSigningSecret = (): boolean => getMediaAccessSigningSecret().length > 0;

const bufferFromBase64Url = (value: string): Buffer | null => {
  const normalized = String(value ?? "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!normalized) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
};

const toBase64Url = (value: Buffer | string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const buildMediaAccessToken = (kind: SignedMediaKind, resourceKey: string): string | null => {
  const secret = getMediaAccessSigningSecret();
  if (!secret) return null;
  const key = String(resourceKey ?? "").trim();
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + MEDIA_ACCESS_TOKEN_TTL_SECONDS;
  const payload = `${kind}:${key}:${exp}`;
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${exp}.${toBase64Url(signature)}`;
};

const validateMediaAccessToken = (
  tokenRaw: any,
  kind: SignedMediaKind,
  resourceKey: string
): boolean => {
  const secret = getMediaAccessSigningSecret();
  if (!secret) return false;
  const token = String(tokenRaw ?? "").trim();
  const key = String(resourceKey ?? "").trim();
  if (!token || !key) return false;
  const [expRaw, signatureRaw] = token.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const providedSignature = bufferFromBase64Url(signatureRaw ?? "");
  if (!providedSignature) return false;
  const payload = `${kind}:${key}:${exp}`;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  if (expectedSignature.length !== providedSignature.length) return false;
  return timingSafeEqual(expectedSignature, providedSignature);
};

const appendMediaAccessToken = (
  path: string,
  kind: SignedMediaKind,
  resourceKey: string
): string => {
  const token = buildMediaAccessToken(kind, resourceKey);
  if (!token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${MEDIA_ACCESS_TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`;
};

const enforceSignedMediaAccess = (
  req: Request,
  res: Response,
  kind: SignedMediaKind,
  resourceKey: string
): boolean => {
  // Public Cloudflare image variants are already publicly readable.
  // This prevents stale `sat` links from breaking images in mobile clients
  // that do not attach auth headers on image requests.
  if (
    kind === "image_id" &&
    MEDIA_ACCESS_ALLOW_PUBLIC_IMAGE_UNSIGNED &&
    isPublicImageVariant()
  ) {
    return true;
  }

  const authenticatedUserId = Number((req as any)?.userId ?? 0);
  const hasAuthenticatedSession =
    Number.isFinite(authenticatedUserId) && authenticatedUserId > 0;

  if (!hasMediaAccessSigningSecret()) {
    if (!MEDIA_ACCESS_TOKEN_ENFORCE) return true;
    formatResponse({
      res,
      success: false,
      code: 500,
      message: "MEDIA_ACCESS_SIGNING_SECRET is not configured",
    });
    return false;
  }
  const tokenRaw = (req.query as any)?.[MEDIA_ACCESS_TOKEN_QUERY_KEY];
  const hasToken = String(tokenRaw ?? "").trim().length > 0;

  if (hasToken) {
    const valid = validateMediaAccessToken(tokenRaw, kind, resourceKey);
    if (valid) return true;

    // If the request carries a valid authenticated session, do not fail
    // only because an old/stale `sat` query param is still present.
    if (hasAuthenticatedSession) return true;

    if (!MEDIA_ACCESS_TOKEN_ENFORCE) return true;

    formatResponse({
      res,
      success: false,
      code: 403,
      message: "invalid or expired media access token",
    });
    return false;
  }

  // Backward compatibility:
  // some app flows still request download/play URLs without `sat`.
  // If request is authenticated with a valid JWT session, allow it.
  if (hasAuthenticatedSession) return true;

  if (!MEDIA_ACCESS_TOKEN_ENFORCE) return true;

  formatResponse({
    res,
    success: false,
    code: 403,
    message: "invalid or expired media access token",
  });
  return false;
};

const pickVideoExt = (contentType: string): string => {
  const lower = contentType.toLowerCase();
  if (lower.includes("quicktime")) return ".mov";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("ogg")) return ".ogv";
  if (lower.includes("x-matroska") || lower.includes("mkv")) return ".mkv";
  return ".mp4";
};

const buildChatVideoObjectKey = (userId: any, contentType: string) => {
  const uid = Number(userId);
  const safeUid = Number.isFinite(uid) && uid > 0 ? uid : 0;
  const prefix = String(process.env.CLOUDFLARE_R2_VIDEO_PREFIX ?? "chat-video")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "");
  const ext = pickVideoExt(contentType);
  const rand = randomBytes(8).toString("hex");
  return `${prefix}-${safeUid}-${Date.now()}-${rand}${ext}`;
};

const pickAudioExt = (contentType: string): string => {
  const lower = contentType.toLowerCase();
  if (lower.includes("mpeg")) return ".mp3";
  if (lower.includes("ogg")) return ".ogg";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("aac")) return ".aac";
  return ".m4a";
};

const buildAudioObjectKey = (userId: any, contentType: string) => {
  const uid = Number(userId);
  const safeUid = Number.isFinite(uid) && uid > 0 ? uid : 0;
  const prefix = String(process.env.CLOUDFLARE_R2_AUDIO_PREFIX ?? "voice")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "");
  const ext = pickAudioExt(contentType);
  const rand = randomBytes(8).toString("hex");
  return `${prefix}-${safeUid}-${Date.now()}-${rand}${ext}`;
};

const pickDocumentExt = (contentType: string): string => {
  const lower = contentType.toLowerCase();
  if (lower.includes("pdf")) return ".pdf";
  if (lower.includes("wordprocessingml")) return ".docx";
  if (lower.includes("msword")) return ".doc";
  if (lower.includes("spreadsheetml")) return ".xlsx";
  if (lower.includes("ms-excel")) return ".xls";
  if (lower.includes("presentationml")) return ".pptx";
  if (lower.includes("ms-powerpoint")) return ".ppt";
  if (lower.includes("csv")) return ".csv";
  if (lower.includes("rtf")) return ".rtf";
  if (lower.includes("zip")) return ".zip";
  if (lower.includes("rar")) return ".rar";
  if (lower.includes("plain")) return ".txt";
  return ".bin";
};

const buildDocumentObjectKey = (userId: any, contentType: string) => {
  const uid = Number(userId);
  const safeUid = Number.isFinite(uid) && uid > 0 ? uid : 0;
  const prefix = String(process.env.CLOUDFLARE_R2_DOCUMENT_PREFIX ?? "document")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "");
  const ext = pickDocumentExt(contentType);
  const rand = randomBytes(8).toString("hex");
  return `${prefix}-${safeUid}-${Date.now()}-${rand}${ext}`;
};

const pickImageExt = (contentType: string): string => {
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("heic")) return ".heic";
  if (lower.includes("heif")) return ".heif";
  return ".webp";
};

const inferImageMimeFromName = (name: string): string | null => {
  const lower = String(name ?? "").trim().toLowerCase();
  if (!lower) return null;
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return null;
};

const inferImageMimeFromBuffer = (buffer: Buffer): string | null => {
  if (!buffer || buffer.length < 12) return null;

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // GIF
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return "image/gif";
  }

  // WEBP RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC/HEIF (ISO BMFF)
  const boxType = buffer.slice(4, 8).toString("ascii");
  const brand = buffer.slice(8, 12).toString("ascii").toLowerCase();
  if (boxType === "ftyp") {
    if (brand.startsWith("heic") || brand.startsWith("heix")) return "image/heic";
    if (brand.startsWith("heif") || brand.startsWith("mif1") || brand.startsWith("msf1")) {
      return "image/heif";
    }
  }

  return null;
};

const normalizeUploadedImageMime = (params: {
  rawMime: string;
  originalName: string;
  buffer: Buffer;
}): string | null => {
  const raw = String(params.rawMime ?? "").trim().toLowerCase();
  if (raw.startsWith("image/")) return raw;

  if (!raw || raw === "application/octet-stream" || raw === "binary/octet-stream") {
    const byName = inferImageMimeFromName(params.originalName);
    if (byName) return byName;
    return inferImageMimeFromBuffer(params.buffer);
  }

  return null;
};

const getLocalImageFallbackPath = (imageId: string) => {
  const safeName = imageId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(LOCAL_IMAGE_FALLBACK_DIR, safeName);
};

const saveLocalImageFallback = async (params: {
  imageId: string;
  buffer: Buffer;
}) => {
  if (!LOCAL_IMAGE_FALLBACK_ENABLED) return false;
  const fullPath = getLocalImageFallbackPath(params.imageId);
  await fs.mkdir(LOCAL_IMAGE_FALLBACK_DIR, { recursive: true });
  await fs.writeFile(fullPath, params.buffer);
  return true;
};

const getLocalImageFallbackStat = async (imageId: string) => {
  try {
    const fullPath = getLocalImageFallbackPath(imageId);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return null;
    return {
      fullPath,
      sizeBytes: Number.isFinite(stat.size) ? stat.size : null,
    };
  } catch {
    return null;
  }
};

const deleteLocalImageFallback = async (imageId: string) => {
  try {
    const fullPath = getLocalImageFallbackPath(imageId);
    await fs.unlink(fullPath);
    return true;
  } catch {
    return false;
  }
};

const buildImageObjectKey = (userId: any, contentType: string) => {
  const uid = Number(userId);
  const safeUid = Number.isFinite(uid) && uid > 0 ? uid : 0;
  const ext = pickImageExt(contentType);
  const rand = randomBytes(8).toString("hex");
  return `${IMAGE_R2_KEY_PREFIX}-${safeUid}-${Date.now()}-${rand}${ext}`;
};

const isR2ImageId = (imageId: string) => imageId.startsWith(`${IMAGE_R2_KEY_PREFIX}-`);

const buildAudioPlaybackPath = (key: string) =>
  appendMediaAccessToken(
    `/api/v1/media/audio/play?key=${encodeURIComponent(key)}`,
    "audio",
    key
  );
const buildDocumentDownloadPath = (key: string) =>
  appendMediaAccessToken(
    `/api/v1/media/document/download?key=${encodeURIComponent(key)}`,
    "document",
    key
  );
const buildImagePlaybackPath = (imageId: string) =>
  appendMediaAccessToken(
    `/api/v1/media/image/play?id=${encodeURIComponent(imageId)}`,
    "image_id",
    imageId
  );
const buildImageFallbackUploadPath = (imageId: string) =>
  appendMediaAccessToken(
    `/api/v1/media/image/direct-upload/fallback?id=${encodeURIComponent(imageId)}`,
    "image_upload",
    imageId
  );
const buildVideoPlaybackPath = (uid: string) =>
  appendMediaAccessToken(
    `/api/v1/media/video/play?uid=${encodeURIComponent(uid)}`,
    "video_uid",
    uid
  );
const buildVideoDownloadPath = (uid: string) =>
  appendMediaAccessToken(
    `/api/v1/media/video/download?uid=${encodeURIComponent(uid)}`,
    "video_uid",
    uid
  );
const buildR2VideoPlaybackPath = (key: string) =>
  appendMediaAccessToken(
    `/api/v1/media/video/play?key=${encodeURIComponent(key)}`,
    "video_key",
    key
  );
const buildR2VideoDownloadPath = (key: string) =>
  appendMediaAccessToken(
    `/api/v1/media/video/download?key=${encodeURIComponent(key)}`,
    "video_key",
    key
  );

const normalizeMediaContext = (value: any): string => String(value ?? "feed").trim().toLowerCase();
const shouldUseR2ForVideoContext = (context: string) =>
  context === "chat" || context === "chat-video";

const normalizeImageId = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const decoded = decodeURIComponent(String(value).trim());
  if (!decoded) return null;
  if (!/^[a-zA-Z0-9._-]{6,255}$/.test(decoded)) return null;
  return decoded;
};

const resolveRequestOrigin = (req: Request): string | null => {
  const protoRaw = String((req.headers as any)["x-forwarded-proto"] ?? req.protocol ?? "https");
  const hostRaw = String((req.headers as any)["x-forwarded-host"] ?? req.headers.host ?? "");
  const proto = protoRaw.split(",")[0].trim() || "https";
  const host = hostRaw.split(",")[0].trim();
  if (!host) return null;
  return `${proto}://${host}`;
};

const normalizeVideoUid = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const decoded = decodeURIComponent(String(value).trim());
  if (!decoded) return null;
  if (!/^[a-f0-9]{32}$/i.test(decoded)) return null;
  return decoded.toLowerCase();
};

type PlaybackRedirectCacheEntry = {
  url: string;
  expiresAt: number;
};

type VideoConfirmSnapshot = {
  uid: string;
  ready: boolean;
  durationSeconds: number | null;
  hls: string | null;
  thumbnail: string | null;
  status: any;
  uploadState: string | null;
  createdAt: string | null;
  ageSeconds: number | null;
};

type VideoConfirmCacheEntry = {
  snapshot: VideoConfirmSnapshot;
  expiresAt: number;
};

const imagePlaybackRedirectCache = new Map<string, PlaybackRedirectCacheEntry>();
const videoPlaybackRedirectCache = new Map<string, PlaybackRedirectCacheEntry>();
const videoConfirmCache = new Map<string, VideoConfirmCacheEntry>();

const setPlaybackCacheHeaders = (res: Response, maxAge: number) => {
  const staleWhileRevalidate = Math.min(60, Math.max(10, Math.floor(maxAge / 3)));
  res.set(
    "Cache-Control",
    `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
  );
};

const setImagePlaybackCacheHeaders = (res: Response) => {
  setPlaybackCacheHeaders(res, IMAGE_PLAYBACK_REDIRECT_TTL_SECONDS);
};

const setVideoPlaybackCacheHeaders = (res: Response) => {
  setPlaybackCacheHeaders(res, VIDEO_PLAYBACK_REDIRECT_TTL_SECONDS);
};

const sanitizeAttachmentFileName = (raw: string, fallback: string) => {
  const normalized = String(raw ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!normalized) return fallback;
  return normalized.slice(0, 120);
};

const streamRemoteDownloadToClient = async (params: {
  res: Response;
  sourceUrl: string;
  fileName: string;
  defaultContentType: string;
}) => {
  const upstream = await axios.get(params.sourceUrl, {
    responseType: "stream",
    timeout: CLOUDFLARE_VIDEO_HTTP_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  const upstreamStatus = Number(upstream.status ?? 0);
  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    const error: any = new Error(
      `upstream download failed with status ${upstreamStatus}`
    );
    error.statusCode = upstreamStatus;
    throw error;
  }

  const contentType =
    String(upstream.headers?.["content-type"] ?? "").trim() ||
    params.defaultContentType;
  const contentLength = String(upstream.headers?.["content-length"] ?? "").trim();
  const dispositionName = sanitizeAttachmentFileName(params.fileName, "download.bin");

  params.res.status(200);
  params.res.setHeader("Content-Type", contentType);
  params.res.setHeader(
    "Content-Disposition",
    `attachment; filename=\"${dispositionName}\"`
  );
  if (contentLength) params.res.setHeader("Content-Length", contentLength);

  await new Promise<void>((resolve, reject) => {
    const stream = upstream.data as NodeJS.ReadableStream;
    stream.on("error", reject);
    params.res.on("finish", resolve);
    params.res.on("close", resolve);
    stream.pipe(params.res);
  });
};

const getCachedPlaybackRedirect = (
  cache: Map<string, PlaybackRedirectCacheEntry>,
  key: string
): string | null => {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.url;
};

const getCachedImagePlaybackRedirect = (imageId: string): string | null => {
  return getCachedPlaybackRedirect(imagePlaybackRedirectCache, imageId);
};

const getCachedVideoPlaybackRedirect = (uid: string): string | null => {
  return getCachedPlaybackRedirect(videoPlaybackRedirectCache, uid);
};

const savePlaybackRedirect = (
  cache: Map<string, PlaybackRedirectCacheEntry>,
  key: string,
  url: string,
  maxItems: number,
  ttlMs: number
) => {
  const now = Date.now();

  if (cache.size >= maxItems) {
    for (const [entryKey, value] of cache.entries()) {
      if (value.expiresAt <= now) {
        cache.delete(entryKey);
      }
    }
  }

  while (cache.size >= maxItems) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }

  cache.set(key, {
    url,
    expiresAt: now + ttlMs,
  });
};

const saveImagePlaybackRedirect = (imageId: string, url: string) => {
  savePlaybackRedirect(
    imagePlaybackRedirectCache,
    imageId,
    url,
    IMAGE_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS,
    IMAGE_PLAYBACK_REDIRECT_CACHE_TTL_MS
  );
};

const saveVideoPlaybackRedirect = (uid: string, url: string) => {
  savePlaybackRedirect(
    videoPlaybackRedirectCache,
    uid,
    url,
    VIDEO_PLAYBACK_REDIRECT_CACHE_MAX_ITEMS,
    VIDEO_PLAYBACK_REDIRECT_CACHE_TTL_MS
  );
};

const getCachedVideoConfirmSnapshot = (uid: string): VideoConfirmSnapshot | null => {
  const cached = videoConfirmCache.get(uid);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    videoConfirmCache.delete(uid);
    return null;
  }
  return cached.snapshot;
};

const saveVideoConfirmSnapshot = (
  uid: string,
  snapshot: VideoConfirmSnapshot,
  ttlMs: number
) => {
  const now = Date.now();

  if (videoConfirmCache.size >= VIDEO_CONFIRM_CACHE_MAX_ITEMS) {
    for (const [entryUid, value] of videoConfirmCache.entries()) {
      if (value.expiresAt <= now) {
        videoConfirmCache.delete(entryUid);
      }
    }
  }

  while (videoConfirmCache.size >= VIDEO_CONFIRM_CACHE_MAX_ITEMS) {
    const oldestUid = videoConfirmCache.keys().next().value;
    if (!oldestUid) break;
    videoConfirmCache.delete(oldestUid);
  }

  videoConfirmCache.set(uid, {
    snapshot,
    expiresAt: now + Math.max(200, ttlMs),
  });
};

const buildVideoConfirmResponseBody = (
  snapshot: VideoConfirmSnapshot,
  mediaSizeBytes: number | null
) => {
  const playbackPath = buildVideoPlaybackPath(snapshot.uid);
  const downloadPath = buildVideoDownloadPath(snapshot.uid);
  const durationCandidate = snapshot.durationSeconds;
  const durationSeconds =
    typeof durationCandidate === "number" &&
    Number.isFinite(durationCandidate) &&
    durationCandidate >= 0
      ? durationCandidate
      : null;

  return {
    video: {
      uid: snapshot.uid,
      ready: snapshot.ready,
      duration_seconds: durationSeconds,
      hls: snapshot.hls,
      playback_url: snapshot.hls,
      proxy_playback_url: playbackPath,
      download_url: downloadPath,
      thumbnail: snapshot.thumbnail,
      status: snapshot.status ?? null,
      upload_state: snapshot.uploadState,
      created_at: snapshot.createdAt,
      age_seconds: snapshot.ageSeconds,
    },
    should_retry_upload: false,
    retry_after_ms: snapshot.ready ? 0 : 2000,
    recommended_chat_payload: {
      message_type: "video",
      media_url: playbackPath,
      media_mime: "application/x-mpegurl",
      media_duration_ms:
        durationSeconds !== null && durationSeconds > 0 ? Math.floor(durationSeconds * 1000) : null,
      media_size_bytes: mediaSizeBytes,
    },
    recommended_download: {
      media_url: downloadPath,
    },
  };
};

type StreamDownloadInfo = {
  status: string;
  url: string | null;
  percentComplete: number | null;
};

const parseStreamDownloadInfo = (entry: any): StreamDownloadInfo | null => {
  if (!entry || typeof entry !== "object") return null;
  const status = String(entry.status ?? "").trim().toLowerCase();
  const urlRaw = String(entry.url ?? "").trim();
  const url = /^https?:\/\//i.test(urlRaw) ? urlRaw : null;
  const percentRaw = Number(entry.percentComplete);
  const percentComplete = Number.isFinite(percentRaw) ? percentRaw : null;

  if (!status && !url) return null;
  return { status, url, percentComplete };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureVideoDownloadReady = async ({
  accountId,
  token,
  uid,
}: {
  accountId: string;
  token: string;
  uid: string;
}): Promise<StreamDownloadInfo | null> => {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/stream/${uid}/downloads`;
  const headers = cloudflareHeaders(token);

  const getInitial = await axios.get(url, { headers });
  let info = parseStreamDownloadInfo(getInitial.data?.result?.default);
  if (info?.status === "ready" && info.url) return info;

  const postCreate = await axios.post(url, {}, { headers });
  info = parseStreamDownloadInfo(postCreate.data?.result?.default) ?? info;
  if (info?.status === "ready" && info.url) return info;

  for (let i = 0; i < 6; i += 1) {
    await sleep(500);
    const poll = await axios.get(url, { headers });
    info = parseStreamDownloadInfo(poll.data?.result?.default) ?? info;
    if (info?.status === "ready" && info.url) return info;
  }

  return info ?? null;
};

const mediaRules = {
  image: {
    max_size_bytes: IMAGE_MAX_BYTES,
    max_resolution_px: IMAGE_MAX_RESOLUTION,
    feed_width_px: IMAGE_FEED_WIDTH,
    output_format: IMAGE_OUTPUT_FORMAT,
    output_quality_percent: IMAGE_OUTPUT_QUALITY,
  },
  video: {
    max_size_bytes: VIDEO_MAX_BYTES,
    max_duration_seconds: VIDEO_MAX_DURATION_SECONDS,
    output_resolution: VIDEO_OUTPUT_RESOLUTION,
    output_codec: VIDEO_OUTPUT_CODEC,
    streaming: VIDEO_STREAMING,
  },
  audio: {
    max_size_bytes: AUDIO_MAX_BYTES,
    max_duration_seconds: AUDIO_MAX_DURATION_SECONDS,
    output_codec: AUDIO_OUTPUT_CODEC,
    streaming: AUDIO_STREAMING,
  },
  document: {
    max_size_bytes: DOCUMENT_MAX_BYTES,
    allowed_mime_types: Array.from(DOCUMENT_ALLOWED_MIME_TYPES),
  },
};

export const media_rules = async (_req: Request, res: Response) => {
  return formatResponse({
    res,
    success: true,
    body: { rules: mediaRules },
  });
};

export const moderate_media_asset = async (req: Request, res: Response) => {
  const body = (req.body as any) ?? {};
  const inferredAssetType =
    body?.image_id || body?.imageId
      ? "image"
      : body?.video_uid || body?.videoUid || body?.uid
      ? "video"
      : null;

  const assetType =
    normalizeModerationAssetType(body?.asset_type ?? body?.assetType) ??
    inferredAssetType;

  if (!assetType) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "asset_type is required (image|video)",
    });
  }

  const imageId = normalizeImageId(body?.image_id ?? body?.imageId);
  const videoUid = normalizeVideoUid(body?.video_uid ?? body?.videoUid ?? body?.uid);

  if (assetType === "image" && !imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "image_id is required for asset_type=image",
    });
  }

  if (assetType === "video" && !videoUid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "video_uid (or uid) is required for asset_type=video",
    });
  }

  const moderationResult = await fetchModerationDecisionFromProvider({
    req,
    assetType,
    imageId,
    videoUid,
    context: normalizeMediaContext(body?.context),
  });

  if (!moderationResult.ok) {
    return formatResponse({
      res,
      success: false,
      code: moderationResult.code,
      message: moderationResult.message,
    });
  }

  const decision = moderationResult.decision;
  return formatResponse({
    res,
    success: true,
    body: {
      moderation: {
        blocked: decision.blocked,
        categories: decision.categories,
        signals: decision.rawSignals,
      },
      confirm_payload: buildModerationConfirmPayload(decision),
    },
  });
};

const buildR2ImageDirectUploadBody = (params: {
  req: Request;
  contentType: string;
  requestedObjectKey?: any;
}) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return {
      ok: false as const,
      code: 500,
      message: config.message,
      body: null,
    };
  }

  const safeContentType = params.contentType || "image/webp";
  const objectKey =
    normalizeImageId(params.requestedObjectKey) ??
    buildImageObjectKey(params.req.userId, safeContentType);
  const origin = resolveRequestOrigin(params.req);
  const uploadPath = buildImageFallbackUploadPath(objectKey);

  try {
    return {
      ok: true as const,
      code: 200,
      message: "",
      body: {
        image_id: objectKey,
        upload_url: origin ? `${origin}${uploadPath}` : uploadPath,
        rules: mediaRules.image,
        delivery: "r2",
        upload_method: "POST",
      },
    };
  } catch (error: any) {
    return {
      ok: false as const,
      code: 502,
      message: error?.message ?? "image direct upload init failed",
      body: null,
    };
  }
};

export const create_image_direct_upload = async (req: Request, res: Response) => {
  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > IMAGE_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `image exceeds ${IMAGE_MAX_BYTES} bytes`,
    });
  }

  const contentType = String((req.body as any)?.content_type ?? "").trim();
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "content_type must be an image/* mime type",
    });
  }

  const forceR2Upload =
    String(process.env.MEDIA_IMAGE_UPLOAD_DELIVERY ?? "")
      .trim()
      .toLowerCase() === "r2";
  if (forceR2Upload) {
    const fallback = buildR2ImageDirectUploadBody({
      req,
      contentType: contentType.toLowerCase(),
      requestedObjectKey: (req.body as any)?.object_key,
    });
    return formatResponse({
      res,
      success: fallback.ok,
      code: fallback.code,
      message: fallback.message || undefined,
      body: fallback.body ?? undefined,
    });
  }

  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    const fallback = buildR2ImageDirectUploadBody({
      req,
      contentType: contentType.toLowerCase(),
      requestedObjectKey: (req.body as any)?.object_key,
    });
    if (fallback.ok) {
      return formatResponse({
        res,
        success: true,
        body: fallback.body,
      });
    }
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  try {
    const formData = new FormData();
    formData.append("requireSignedURLs", "false");
    formData.append(
      "metadata",
      JSON.stringify({
        userId: String(req.userId ?? ""),
        app: "minhoo",
        context: String((req.body as any)?.context ?? "feed"),
      })
    );

    const response = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v2/direct_upload`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
        },
        body: formData,
      }
    );

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!payload?.success) {
      const firstError =
        payload?.errors?.[0]?.message ?? "cloudflare images upload failed";
      const uploadError: any = new Error(firstError);
      uploadError.statusCode = Number(response.status ?? 0);
      uploadError.response = {
        status: Number(response.status ?? 0),
        data: payload,
      };
      throw uploadError;
    }

    const result = payload?.result ?? {};
    return formatResponse({
      res,
      success: true,
      body: {
        image_id: result.id ?? null,
        upload_url: result.uploadURL ?? null,
        rules: mediaRules.image,
      },
    });
  } catch (error: any) {
    if (isCloudflareAuthError(error) || isCloudflareTransientError(error)) {
      const fallback = buildR2ImageDirectUploadBody({
        req,
        contentType: contentType.toLowerCase(),
        requestedObjectKey: (req.body as any)?.object_key,
      });
      if (fallback.ok) {
        return formatResponse({
          res,
          success: true,
          body: fallback.body,
        });
      }
    }
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const image_direct_upload_fallback_middleware = uploadImageFallback.any();

export const image_direct_upload_fallback = async (req: Request, res: Response) => {
  const imageId =
    normalizeImageId((req.query as any)?.id) ??
    normalizeImageId((req.query as any)?.image_id) ??
    normalizeImageId((req.body as any)?.image_id);
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id (or image_id) is required",
    });
  }
  if (!isR2ImageId(imageId)) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "invalid fallback image id",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "image_upload", imageId)) return;

  const files = ((req as any).files ?? []) as Array<{
    buffer?: Buffer;
    size?: number;
    mimetype?: string;
    originalname?: string;
  }>;
  const firstFile = files.find((entry) => entry?.buffer && entry.buffer.length > 0);
  if (!firstFile?.buffer) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "multipart form-data with file is required",
    });
  }

  const config = ensureR2Config();
  if (!config.ok) {
    try {
      const stored = await saveLocalImageFallback({
        imageId,
        buffer: firstFile.buffer,
      });
      if (stored) {
        return formatResponse({
          res,
          success: true,
          body: {
            image_id: imageId,
            uploaded: true,
            delivery: "local",
          },
        });
      }
    } catch {
      // noop
    }
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const mime = normalizeUploadedImageMime({
    rawMime: String(firstFile.mimetype ?? ""),
    originalName: String(firstFile.originalname ?? ""),
    buffer: firstFile.buffer,
  });
  if (!mime) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uploaded file must be image/*",
    });
  }
  const sizeBytes = Number(firstFile.size ?? firstFile.buffer.length ?? 0);
  if (Number.isFinite(sizeBytes) && sizeBytes > IMAGE_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `image exceeds ${IMAGE_MAX_BYTES} bytes`,
    });
  }

  try {
    const putUrl = buildR2PresignedUrl({
      method: "PUT",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: imageId,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: IMAGE_UPLOAD_TTL_SECONDS,
    });

    const uploadResponse = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "Content-Type": mime || "application/octet-stream",
      },
      body: firstFile.buffer as any,
    });
    if (!uploadResponse.ok) {
      try {
        const stored = await saveLocalImageFallback({
          imageId,
          buffer: firstFile.buffer,
        });
        if (stored) {
          return formatResponse({
            res,
            success: true,
            body: {
              image_id: imageId,
              uploaded: true,
              delivery: "local",
            },
          });
        }
      } catch {
        // noop
      }
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: `r2 upload failed (${uploadResponse.status})`,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        image_id: imageId,
        uploaded: true,
        delivery: "r2",
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "image fallback upload failed",
    });
  }
};

export const confirm_image_upload = async (req: Request, res: Response) => {
  const imageId = normalizeImageId((req.body as any)?.image_id);
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "image_id is required",
    });
  }
  const moderationResult = await resolveConfirmModerationDecision({
    req,
    assetType: "image",
    imageId,
  });
  if (!moderationResult.ok) {
    return formatResponse({
      res,
      success: false,
      code: moderationResult.code,
      message: moderationResult.message,
    });
  }
  const moderationDecision = moderationResult.decision;
  if (moderationDecision.blocked) {
    return respondModerationBlocked({
      req,
      res,
      assetType: "image",
      decision: moderationDecision,
    });
  }

  if (isR2ImageId(imageId)) {
    const localSnapshot = await getLocalImageFallbackStat(imageId);
    if (localSnapshot) {
      const playbackPath = buildImagePlaybackPath(imageId);
      return formatResponse({
        res,
        success: true,
        body: {
          image: {
            id: imageId,
            ready: true,
            uploaded: null,
            variant: "local",
            url: playbackPath,
            playback_url: playbackPath,
            variants: [playbackPath],
            delivery: "local",
          },
          recommended_chat_payload: {
            message_type: "image",
            media_url: playbackPath,
            media_mime: "image/webp",
            media_duration_ms: null,
            media_size_bytes:
              parsePositiveInt((req.body as any)?.file_size_bytes) ?? localSnapshot.sizeBytes,
          },
        },
      });
    }

    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const headUrl = buildR2PresignedUrl({
        method: "HEAD",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: imageId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: 60,
      });
      const headResponse = await fetch(headUrl, { method: "HEAD" });
      if (!headResponse.ok) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: `image object is not available yet (${headResponse.status})`,
        });
      }

      const mime = String(headResponse.headers.get("content-type") ?? "").trim() || null;
      const sizeBytesRaw = Number(headResponse.headers.get("content-length") ?? 0);
      const sizeBytes =
        Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? Math.floor(sizeBytesRaw) : null;
      if (sizeBytes !== null && sizeBytes > IMAGE_MAX_BYTES) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: `image exceeds ${IMAGE_MAX_BYTES} bytes`,
        });
      }

      const playbackPath = buildImagePlaybackPath(imageId);
      return formatResponse({
        res,
        success: true,
        body: {
          image: {
            id: imageId,
            ready: true,
            uploaded: null,
            variant: "r2",
            url: playbackPath,
            playback_url: playbackPath,
            variants: [playbackPath],
            delivery: "r2",
          },
          recommended_chat_payload: {
            message_type: "image",
            media_url: playbackPath,
            media_mime: mime && mime.startsWith("image/") ? mime : "image/webp",
            media_duration_ms: null,
            media_size_bytes:
              parsePositiveInt((req.body as any)?.file_size_bytes) ?? sizeBytes,
          },
        },
      });
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "image confirm failed",
      });
    }
  }

  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const playbackPath = buildImagePlaybackPath(imageId);
  const fallbackPayload = {
    image: {
      id: imageId,
      ready: true,
      uploaded: null,
      variant: getImageVariant(),
      url: playbackPath,
      playback_url: playbackPath,
      variants: [playbackPath],
      confirmation_state: "deferred",
    },
    recommended_chat_payload: {
      message_type: "image",
      media_url: playbackPath,
      media_mime: "image/webp",
      media_duration_ms: null,
      media_size_bytes: parsePositiveInt((req.body as any)?.file_size_bytes),
    },
  };

  const cachedRedirectTarget = getCachedImagePlaybackRedirect(imageId);
  if (cachedRedirectTarget) {
    return formatResponse({
      res,
      success: true,
      body: {
        image: {
          id: imageId,
          ready: true,
          uploaded: null,
          variant: getImageVariant(),
          url: cachedRedirectTarget,
          playback_url: playbackPath,
          variants: [cachedRedirectTarget],
        },
        recommended_chat_payload: {
          message_type: "image",
          media_url: cachedRedirectTarget,
          media_mime: "image/webp",
          media_duration_ms: null,
          media_size_bytes: parsePositiveInt((req.body as any)?.file_size_bytes),
        },
      },
    });
  }

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v1/${imageId}`,
      {
        headers: cloudflareHeaders(config.token),
        timeout: CLOUDFLARE_IMAGE_CONFIRM_TIMEOUT_MS,
      }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare image lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const variants = Array.isArray(result.variants) ? result.variants : [];
    const preferredVariant = variants.find((url: string) =>
      url.endsWith(`/${getImageVariant()}`)
    );
    const directVariantUrl = preferredVariant ?? variants[0] ?? null;
    const resolvedImageId = String(result.id ?? imageId).trim() || imageId;
    const resolvedPlaybackPath = buildImagePlaybackPath(resolvedImageId);

    if (directVariantUrl) {
      saveImagePlaybackRedirect(resolvedImageId, directVariantUrl);
    }

    return formatResponse({
      res,
      success: true,
      body: {
        image: {
          id: resolvedImageId,
          ready: !result.draft,
          uploaded: result.uploaded ?? null,
          variant: getImageVariant(),
          url: directVariantUrl,
          playback_url: resolvedPlaybackPath,
          variants,
        },
        recommended_chat_payload: {
          message_type: "image",
          media_url: directVariantUrl ?? resolvedPlaybackPath,
          media_mime: "image/webp",
          media_duration_ms: null,
          media_size_bytes: parsePositiveInt((req.body as any)?.file_size_bytes),
        },
      },
    });
  } catch (error: any) {
    if (isCloudflareTransientError(error)) {
      return formatResponse({
        res,
        success: true,
        body: fallbackPayload,
      });
    }
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const delete_image_asset = async (req: Request, res: Response) => {
  const imageId = String((req.params as any)?.id ?? "").trim();
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id is required",
    });
  }

  if (isR2ImageId(imageId)) {
    const deletedLocal = await deleteLocalImageFallback(imageId);
    if (deletedLocal) {
      return formatResponse({
        res,
        success: true,
        body: { deleted: true, image_id: imageId },
      });
    }

    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const deleteUrl = buildR2PresignedUrl({
        method: "DELETE",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: imageId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: 60,
      });
      const deleteResponse = await fetch(deleteUrl, { method: "DELETE" });
      if (!deleteResponse.ok) {
        return formatResponse({
          res,
          success: false,
          code: 502,
          message: `image delete failed (${deleteResponse.status})`,
        });
      }

      return formatResponse({
        res,
        success: true,
        body: { deleted: true, image_id: imageId },
      });
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "image delete failed",
      });
    }
  }

  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  try {
    const response = await axios.delete(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v1/${imageId}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare image delete failed";
      throw new Error(firstError);
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, image_id: imageId },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const create_video_direct_upload = async (req: Request, res: Response) => {
  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > VIDEO_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `video exceeds ${VIDEO_MAX_BYTES} bytes`,
    });
  }

  const context = normalizeMediaContext((req.body as any)?.context);
  const useR2 = shouldUseR2ForVideoContext(context);
  const contentType = String((req.body as any)?.content_type ?? "").trim().toLowerCase();
  if (contentType && !contentType.startsWith("video/")) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "content_type must be a video/* mime type",
    });
  }

  if (useR2) {
    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const safeContentType = contentType || "video/mp4";
      const objectKey =
        normalizeVideoStorageKey((req.body as any)?.object_key) ??
        buildChatVideoObjectKey(req.userId, safeContentType);
      const uploadUrl = buildR2PresignedUrl({
        method: "PUT",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: objectKey,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: VIDEO_UPLOAD_TTL_SECONDS,
      });

      return formatResponse({
        res,
        success: true,
        body: {
          uid: objectKey,
          key: objectKey,
          object_key: objectKey,
          content_type: safeContentType,
          upload_url: uploadUrl,
          upload_expires_at: null,
          playback_url: buildR2VideoPlaybackPath(objectKey),
          download_url: buildR2VideoDownloadPath(objectKey),
          delivery: "r2",
          context,
          rules: {
            ...mediaRules.video,
            streaming: VIDEO_R2_STREAMING,
          },
        },
      });
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "video direct upload init failed",
      });
    }
  }

  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  try {
    const allowedOrigins = parseCsv(process.env.CLOUDFLARE_STREAM_ALLOWED_ORIGINS);
    const payload: any = {
      maxDurationSeconds: VIDEO_MAX_DURATION_SECONDS,
      creator: String(req.userId ?? ""),
      meta: {
        userId: String(req.userId ?? ""),
        app: "minhoo",
        context,
      },
    };

    if (allowedOrigins.length) payload.allowedOrigins = allowedOrigins;

    const response = await axios.post(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/direct_upload`,
      payload,
      {
        headers: cloudflareHeaders(config.token),
        timeout: CLOUDFLARE_VIDEO_HTTP_TIMEOUT_MS,
      }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream upload failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    console.log(
      `[media][video-direct-upload] userId=${req.userId ?? 0} uid=${String(result.uid ?? "")} hasUploadUrl=${Boolean(
        result.uploadURL
      )}`
    );
    return formatResponse({
      res,
      success: true,
      body: {
        uid: result.uid ?? null,
        upload_url: result.uploadURL ?? null,
        upload_expires_at: result.expiry ?? null,
        rules: mediaRules.video,
      },
    });
  } catch (error: any) {
    if (isAxiosTimeoutError(error)) {
      return formatResponse({
        res,
        success: false,
        code: 504,
        message: "video direct upload init timeout, retry",
      });
    }
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const confirm_video_upload = async (req: Request, res: Response) => {
  const context = normalizeMediaContext((req.body as any)?.context);
  const requestedKey =
    normalizeVideoStorageKey((req.body as any)?.object_key) ??
    normalizeVideoStorageKey((req.body as any)?.key);
  const requestedUid = normalizeVideoUid((req.body as any)?.uid);
  const requestedKeyFromUid = !requestedUid
    ? normalizeVideoStorageKey((req.body as any)?.uid)
    : null;
  const useR2 =
    shouldUseR2ForVideoContext(context) ||
    (!requestedUid && Boolean(requestedKey || requestedKeyFromUid));

  if (!useR2 && !requestedUid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }

  const moderationResult = useR2
    ? ({ ok: true, decision: resolveModerationDecision(req) } as const)
    : await resolveConfirmModerationDecision({
        req,
        assetType: "video",
        videoUid: requestedUid,
      });
  if (!moderationResult.ok) {
    return formatResponse({
      res,
      success: false,
      code: moderationResult.code,
      message: moderationResult.message,
    });
  }
  const moderationDecision = moderationResult.decision;
  if (moderationDecision.blocked) {
    return respondModerationBlocked({
      req,
      res,
      assetType: "video",
      decision: moderationDecision,
    });
  }

  if (useR2) {
    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    const objectKey = requestedKey ?? requestedKeyFromUid;
    if (!objectKey) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "object_key (or uid) is required",
      });
    }

    try {
      const headUrl = buildR2PresignedUrl({
        method: "HEAD",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: objectKey,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: 60,
      });
      const headResponse = await fetch(headUrl, { method: "HEAD" });
      if (!headResponse.ok) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: `video object is not available yet (${headResponse.status})`,
        });
      }

      const sizeBytesRaw = Number(headResponse.headers.get("content-length") ?? 0);
      const sizeBytes =
        Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? Math.floor(sizeBytesRaw) : null;
      if (sizeBytes !== null && sizeBytes > VIDEO_MAX_BYTES) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: `video exceeds ${VIDEO_MAX_BYTES} bytes`,
        });
      }

      const mime = String(headResponse.headers.get("content-type") ?? "").trim() || null;
      if (mime && !mime.toLowerCase().startsWith("video/")) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: "uploaded object is not a video/* mime type",
        });
      }

      const durationMsInput = parsePositiveInt(
        (req.body as any)?.media_duration_ms ?? (req.body as any)?.mediaDurationMs
      );
      const durationSecondsInput = parsePositiveInt(
        (req.body as any)?.duration_seconds ?? (req.body as any)?.durationSeconds
      );
      const durationMs =
        durationMsInput ??
        (durationSecondsInput !== null ? Math.floor(durationSecondsInput * 1000) : null);
      if (durationMs !== null && durationMs > VIDEO_MAX_DURATION_SECONDS * 1000) {
        return formatResponse({
          res,
          success: false,
          code: 409,
          message: `video duration exceeds ${VIDEO_MAX_DURATION_SECONDS}s`,
        });
      }

      const playbackPath = buildR2VideoPlaybackPath(objectKey);
      const downloadPath = buildR2VideoDownloadPath(objectKey);
      const thumbnailUrl = String(
        (req.body as any)?.thumbnail_url ?? (req.body as any)?.thumbnailUrl ?? ""
      ).trim() || null;

      return formatResponse({
        res,
        success: true,
        body: {
          video: {
            uid: objectKey,
            key: objectKey,
            object_key: objectKey,
            delivery: "r2",
            ready: true,
            duration_seconds: durationMs !== null ? Math.floor(durationMs / 1000) : null,
            hls: null,
            playback_url: playbackPath,
            download_url: downloadPath,
            thumbnail: thumbnailUrl,
            status: { state: "ready" },
            upload_state: "ready",
          },
          should_retry_upload: false,
          retry_after_ms: 0,
          recommended_chat_payload: {
            message_type: "video",
            media_url: playbackPath,
            media_mime: mime && mime.startsWith("video/") ? mime : "video/mp4",
            media_duration_ms: durationMs,
            media_size_bytes: sizeBytes,
            metadata: {
              delivery: "r2",
              thumbnail_url: thumbnailUrl,
            },
          },
          recommended_download: {
            media_url: downloadPath,
          },
        },
      });
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "video confirm failed",
      });
    }
  }

  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const uid = requestedUid;
  if (!uid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }
  const requestedMediaSizeBytes = parsePositiveInt((req.body as any)?.file_size_bytes);

  const cachedSnapshot = getCachedVideoConfirmSnapshot(uid);
  if (cachedSnapshot) {
    console.log(
      `[media][video-confirm] userId=${req.userId ?? 0} uid=${uid} source=cache ready=${cachedSnapshot.ready}`
    );
    return formatResponse({
      res,
      success: true,
      body: buildVideoConfirmResponseBody(cachedSnapshot, requestedMediaSizeBytes),
    });
  }

  const cachedRedirectTarget = getCachedVideoPlaybackRedirect(uid);
  if (cachedRedirectTarget) {
    const shortcutSnapshot: VideoConfirmSnapshot = {
      uid,
      ready: true,
      durationSeconds: null,
      hls: cachedRedirectTarget,
      thumbnail: `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=1s`,
      status: { state: "ready", source: "playback_cache" },
      uploadState: "ready",
      createdAt: null,
      ageSeconds: null,
    };
    saveVideoConfirmSnapshot(uid, shortcutSnapshot, VIDEO_CONFIRM_READY_CACHE_TTL_MS);
    console.log(
      `[media][video-confirm] userId=${req.userId ?? 0} uid=${uid} source=playback-cache ready=true`
    );
    return formatResponse({
      res,
      success: true,
      body: buildVideoConfirmResponseBody(shortcutSnapshot, requestedMediaSizeBytes),
    });
  }

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/${uid}`,
      {
        headers: cloudflareHeaders(config.token),
        timeout: CLOUDFLARE_VIDEO_HTTP_TIMEOUT_MS,
      }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const readyToStream = Boolean(result.readyToStream);
    const statusState = String((result as any)?.status?.state ?? "")
      .trim()
      .toLowerCase();
    const createdAt = String((result as any)?.created ?? "").trim() || null;
    const createdAtMs = parseDateMs(createdAt);
    const ageSeconds =
      createdAtMs != null
        ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000))
        : null;

    console.log(
      `[media][video-confirm] userId=${req.userId ?? 0} uid=${uid} ready=${readyToStream} state=${statusState || "unknown"} ageSec=${
        ageSeconds ?? -1
      }`
    );

    if (
      statusState === "pendingupload" &&
      ageSeconds !== null &&
      ageSeconds >= VIDEO_PENDINGUPLOAD_STALE_SECONDS
    ) {
      return res.status(409).json({
        header: {
          success: false,
          authenticated: false,
          code: 409,
          messages: [
            "Internal error, please consult the administrator",
            "video upload is incomplete (pendingupload), retry upload",
          ],
        },
        body: {
          uid,
          upload_state: statusState,
          should_retry_upload: true,
          retry_after_ms: 0,
          created_at: createdAt,
          age_seconds: ageSeconds,
        },
      });
    }

    const duration = Number(result.duration ?? 0);
    if (Number.isFinite(duration) && duration > VIDEO_MAX_DURATION_SECONDS) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `video duration exceeds ${VIDEO_MAX_DURATION_SECONDS}s`,
      });
    }

    const directPlaybackBaseUrl = getStreamPlaybackBaseUrl();
    const hls =
      result?.playback?.hls ??
      (uid && directPlaybackBaseUrl
        ? `${directPlaybackBaseUrl}/${uid}/manifest/video.m3u8`
        : uid
        ? `https://videodelivery.net/${uid}/manifest/video.m3u8`
        : null);
    const thumbnail =
      result?.thumbnail ??
      (uid ? `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg?time=1s` : null);
    const durationSeconds = Number.isFinite(duration) ? duration : null;
    const snapshot: VideoConfirmSnapshot = {
      uid,
      ready: readyToStream,
      durationSeconds,
      hls,
      thumbnail,
      status: result.status ?? null,
      uploadState: statusState || null,
      createdAt,
      ageSeconds,
    };

    if (readyToStream && hls) {
      saveVideoPlaybackRedirect(uid, hls);
    }
    saveVideoConfirmSnapshot(
      uid,
      snapshot,
      readyToStream ? VIDEO_CONFIRM_READY_CACHE_TTL_MS : VIDEO_CONFIRM_PENDING_CACHE_TTL_MS
    );

    return formatResponse({
      res,
      success: true,
      body: buildVideoConfirmResponseBody(snapshot, requestedMediaSizeBytes),
    });
  } catch (error: any) {
    if (isAxiosTimeoutError(error)) {
      return formatResponse({
        res,
        success: false,
        code: 504,
        message: "video confirm timeout, retry",
      });
    }
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const delete_video_asset = async (req: Request, res: Response) => {
  const rawUid = String((req.params as any)?.uid ?? (req.query as any)?.uid ?? "").trim();
  const explicitKey =
    normalizeVideoStorageKey((req.query as any)?.key) ??
    normalizeVideoStorageKey((req.params as any)?.key);
  const uid = normalizeVideoUid(rawUid);
  const objectKey = explicitKey ?? (!uid ? normalizeVideoStorageKey(rawUid) : null);

  if (!uid && !objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid (or key) is required",
    });
  }

  if (objectKey) {
    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const deleteUrl = buildR2PresignedUrl({
        method: "DELETE",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: objectKey,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: 60,
      });
      const deleteResponse = await fetch(deleteUrl, { method: "DELETE" });
      if (!deleteResponse.ok) {
        return formatResponse({
          res,
          success: false,
          code: 502,
          message: `video delete failed (${deleteResponse.status})`,
        });
      }

      return formatResponse({
        res,
        success: true,
        body: { deleted: true, uid: objectKey, key: objectKey },
      });
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "video delete failed",
      });
    }
  }

  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  try {
    const response = await axios.delete(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/${uid}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream delete failed";
      throw new Error(firstError);
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, uid },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const create_audio_direct_upload = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > AUDIO_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `audio exceeds ${AUDIO_MAX_BYTES} bytes`,
    });
  }

  const contentType = String((req.body as any)?.content_type ?? "").trim().toLowerCase();
  if (contentType && !contentType.startsWith("audio/")) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "content_type must be an audio/* mime type",
    });
  }

  try {
    const safeContentType = contentType || "audio/m4a";
    const objectKey =
      normalizeAudioKey((req.body as any)?.object_key) ??
      buildAudioObjectKey(req.userId, safeContentType);

    const uploadUrl = buildR2PresignedUrl({
      method: "PUT",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: AUDIO_UPLOAD_TTL_SECONDS,
    });

    const playbackPath = buildAudioPlaybackPath(objectKey);
    return formatResponse({
      res,
      success: true,
      body: {
        uid: objectKey, // compat con front existente
        key: objectKey,
        object_key: objectKey,
        content_type: safeContentType,
        upload_url: uploadUrl,
        playback_url: playbackPath,
        delivery: "r2",
        rules: mediaRules.audio,
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "audio direct upload init failed",
    });
  }
};

export const confirm_audio_upload = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeAudioKey((req.body as any)?.object_key) ??
    normalizeAudioKey((req.body as any)?.key) ??
    normalizeAudioKey((req.body as any)?.uid);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "object_key (or uid) is required",
    });
  }

  try {
    const headUrl = buildR2PresignedUrl({
      method: "HEAD",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: 60,
    });
    const headResponse = await fetch(headUrl, { method: "HEAD" });
    if (!headResponse.ok) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `audio object is not available yet (${headResponse.status})`,
      });
    }

    const sizeBytesRaw = Number(headResponse.headers.get("content-length") ?? 0);
    const sizeBytes =
      Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? Math.floor(sizeBytesRaw) : null;
    if (sizeBytes !== null && sizeBytes > AUDIO_MAX_BYTES) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `audio exceeds ${AUDIO_MAX_BYTES} bytes`,
      });
    }

    const mime = String(headResponse.headers.get("content-type") ?? "").trim() || null;
    const durationMsInput = parsePositiveInt(
      (req.body as any)?.media_duration_ms ?? (req.body as any)?.mediaDurationMs
    );
    const durationSecondsInput = parsePositiveInt(
      (req.body as any)?.duration_seconds ?? (req.body as any)?.durationSeconds
    );
    const durationMs =
      durationMsInput ??
      (durationSecondsInput !== null ? Math.floor(durationSecondsInput * 1000) : null);
    if (durationMs !== null && durationMs > AUDIO_MAX_DURATION_SECONDS * 1000) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `audio duration exceeds ${AUDIO_MAX_DURATION_SECONDS}s`,
      });
    }

    const playbackPath = buildAudioPlaybackPath(objectKey);

    return formatResponse({
      res,
      success: true,
      body: {
        audio: {
          uid: objectKey,
          key: objectKey,
          object_key: objectKey,
          ready: true,
          duration_seconds: durationMs !== null ? Math.floor(durationMs / 1000) : null,
          mime,
          size_bytes: sizeBytes,
          playback_url: playbackPath,
          status: { state: "ready" },
        },
        recommended_chat_payload: {
          message_type: "voice",
          media_url: playbackPath,
          media_mime: mime && mime.startsWith("audio/") ? mime : null,
          media_duration_ms: durationMs,
          media_size_bytes: sizeBytes,
        },
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "audio confirm failed",
    });
  }
};

export const create_document_direct_upload = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const fileSize = parsePositiveInt((req.body as any)?.file_size_bytes);
  if (fileSize !== null && fileSize > DOCUMENT_MAX_BYTES) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: `document exceeds ${DOCUMENT_MAX_BYTES} bytes`,
    });
  }

  const contentType = String((req.body as any)?.content_type ?? "").trim().toLowerCase();
  if (contentType && !isAllowedDocumentContentType(contentType)) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "content_type must be a supported document mime type",
    });
  }

  try {
    const safeContentType = contentType || "application/octet-stream";
    const objectKey =
      normalizeDocumentKey((req.body as any)?.object_key) ??
      normalizeDocumentKey((req.body as any)?.key) ??
      normalizeDocumentKey((req.body as any)?.uid) ??
      buildDocumentObjectKey(req.userId, safeContentType);

    const uploadUrl = buildR2PresignedUrl({
      method: "PUT",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: DOCUMENT_UPLOAD_TTL_SECONDS,
    });

    const downloadPath = buildDocumentDownloadPath(objectKey);
    return formatResponse({
      res,
      success: true,
      body: {
        uid: objectKey,
        key: objectKey,
        object_key: objectKey,
        content_type: safeContentType,
        upload_url: uploadUrl,
        download_url: downloadPath,
        delivery: "r2",
        rules: mediaRules.document,
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "document direct upload init failed",
    });
  }
};

export const confirm_document_upload = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeDocumentKey((req.body as any)?.object_key) ??
    normalizeDocumentKey((req.body as any)?.key) ??
    normalizeDocumentKey((req.body as any)?.uid);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "object_key (or uid) is required",
    });
  }

  try {
    const headUrl = buildR2PresignedUrl({
      method: "HEAD",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: 60,
    });
    const headResponse = await fetch(headUrl, { method: "HEAD" });
    if (!headResponse.ok) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `document object is not available yet (${headResponse.status})`,
      });
    }

    const sizeBytesRaw = Number(headResponse.headers.get("content-length") ?? 0);
    const sizeBytes =
      Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? Math.floor(sizeBytesRaw) : null;
    if (sizeBytes !== null && sizeBytes > DOCUMENT_MAX_BYTES) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: `document exceeds ${DOCUMENT_MAX_BYTES} bytes`,
      });
    }

    const mimeRaw = String(headResponse.headers.get("content-type") ?? "")
      .trim()
      .toLowerCase();
    const mime =
      mimeRaw && isAllowedDocumentContentType(mimeRaw) ? mimeRaw : "application/octet-stream";

    const downloadPath = buildDocumentDownloadPath(objectKey);

    return formatResponse({
      res,
      success: true,
      body: {
        document: {
          uid: objectKey,
          key: objectKey,
          object_key: objectKey,
          ready: true,
          mime,
          size_bytes: sizeBytes,
          download_url: downloadPath,
          status: { state: "ready" },
        },
        recommended_chat_payload: {
          message_type: "document",
          media_url: downloadPath,
          media_mime: mime,
          media_duration_ms: null,
          media_size_bytes: sizeBytes,
        },
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "document confirm failed",
    });
  }
};

export const audio_playback = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeAudioKey((req.query as any)?.key) ??
    normalizeAudioKey((req.params as any)?.key);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "key is required",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "audio", objectKey)) return;

  try {
    const getUrl = buildR2PresignedUrl({
      method: "GET",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: AUDIO_PLAY_TTL_SECONDS,
    });

    return res.redirect(302, getUrl);
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "audio playback redirect failed",
    });
  }
};

export const document_download = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeDocumentKey((req.query as any)?.key) ??
    normalizeDocumentKey((req.query as any)?.uid) ??
    normalizeDocumentKey((req.params as any)?.key) ??
    normalizeDocumentKey((req.params as any)?.uid);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "key (or uid) is required",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "document", objectKey)) return;

  try {
    const getUrl = buildR2PresignedUrl({
      method: "GET",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: DOCUMENT_DOWNLOAD_TTL_SECONDS,
    });

    return res.redirect(302, getUrl);
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "document download redirect failed",
    });
  }
};

export const image_playback = async (req: Request, res: Response) => {
  const imageId =
    normalizeImageId((req.query as any)?.id) ??
    normalizeImageId((req.params as any)?.id);
  if (!imageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id is required",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "image_id", imageId)) return;

  if (isR2ImageId(imageId)) {
    const localSnapshot = await getLocalImageFallbackStat(imageId);
    if (localSnapshot) {
      const byExt = inferImageMimeFromName(imageId);
      res.setHeader("Content-Type", byExt || "application/octet-stream");
      setImagePlaybackCacheHeaders(res);
      return res.sendFile(localSnapshot.fullPath);
    }

    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const getUrl = buildR2PresignedUrl({
        method: "GET",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: imageId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: IMAGE_PLAY_TTL_SECONDS,
      });
      setImagePlaybackCacheHeaders(res);
      return res.redirect(302, getUrl);
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "image playback redirect failed",
      });
    }
  }

  const config = ensureCloudflareConfig("images");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const cachedRedirectTarget = getCachedImagePlaybackRedirect(imageId);
  if (cachedRedirectTarget) {
    setImagePlaybackCacheHeaders(res);
    return res.redirect(302, cachedRedirectTarget);
  }

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/images/v1/${imageId}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare image lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const variants = Array.isArray(result.variants) ? result.variants : [];
    const preferredVariant = variants.find((url: string) =>
      url.endsWith(`/${getImageVariant()}`)
    );
    const redirectTarget = preferredVariant ?? variants[0] ?? null;
    if (!redirectTarget) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "image variant not available",
      });
    }

    saveImagePlaybackRedirect(imageId, redirectTarget);
    setImagePlaybackCacheHeaders(res);
    return res.redirect(302, redirectTarget);
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "image playback redirect failed",
    });
  }
};

export const video_playback = async (req: Request, res: Response) => {
  const explicitKey =
    normalizeVideoStorageKey((req.query as any)?.key) ??
    normalizeVideoStorageKey((req.params as any)?.key);
  const rawUid = String((req.query as any)?.uid ?? (req.params as any)?.uid ?? "").trim();
  const uid = normalizeVideoUid(rawUid);
  const objectKey = explicitKey ?? (!uid ? normalizeVideoStorageKey(rawUid) : null);

  if (objectKey) {
    if (!enforceSignedMediaAccess(req, res, "video_key", objectKey)) return;
    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const getUrl = buildR2PresignedUrl({
        method: "GET",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: objectKey,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: VIDEO_PLAY_TTL_SECONDS,
      });

      return res.redirect(302, getUrl);
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "video playback redirect failed",
      });
    }
  }

  const cachedRedirectTarget = uid ? getCachedVideoPlaybackRedirect(uid) : null;
  if (cachedRedirectTarget) {
    setVideoPlaybackCacheHeaders(res);
    return res.redirect(302, cachedRedirectTarget);
  }

  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  if (!uid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "video_uid", uid)) return;

  try {
    const response = await axios.get(
      `${CLOUDFLARE_API_BASE}/accounts/${config.accountId}/stream/${uid}`,
      { headers: cloudflareHeaders(config.token) }
    );

    if (!response.data?.success) {
      const firstError =
        response.data?.errors?.[0]?.message ?? "cloudflare stream lookup failed";
      throw new Error(firstError);
    }

    const result = response.data?.result ?? {};
    const hls =
      result?.playback?.hls ??
      (uid ? `https://videodelivery.net/${uid}/manifest/video.m3u8` : null);
    if (!hls) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "video playback URL not available",
      });
    }

    saveVideoPlaybackRedirect(uid, hls);
    setVideoPlaybackCacheHeaders(res);
    return res.redirect(302, hls);
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "video playback redirect failed",
    });
  }
};

export const video_download = async (req: Request, res: Response) => {
  const explicitKey =
    normalizeVideoStorageKey((req.query as any)?.key) ??
    normalizeVideoStorageKey((req.params as any)?.key);
  const rawUid = String((req.query as any)?.uid ?? (req.params as any)?.uid ?? "").trim();
  const uid = normalizeVideoUid(rawUid);
  const objectKey = explicitKey ?? (!uid ? normalizeVideoStorageKey(rawUid) : null);

  if (objectKey) {
    if (!enforceSignedMediaAccess(req, res, "video_key", objectKey)) return;
    const config = ensureR2Config();
    if (!config.ok) {
      return formatResponse({
        res,
        success: false,
        code: 500,
        message: config.message,
      });
    }

    try {
      const getUrl = buildR2PresignedUrl({
        method: "GET",
        bucket: config.bucket,
        endpoint: config.endpoint,
        key: objectKey,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        expiresSeconds: VIDEO_DOWNLOAD_TTL_SECONDS,
      });
      if (VIDEO_DOWNLOAD_SHOULD_PROXY) {
        await streamRemoteDownloadToClient({
          res,
          sourceUrl: getUrl,
          fileName: objectKey,
          defaultContentType: "video/mp4",
        });
        return;
      }

      return res.redirect(302, getUrl);
    } catch (error: any) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: error?.message ?? "video download redirect failed",
      });
    }
  }

  const config = ensureCloudflareConfig("media");
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  if (!uid) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid is required",
    });
  }
  if (!enforceSignedMediaAccess(req, res, "video_uid", uid)) return;

  try {
    const info = await ensureVideoDownloadReady({
      accountId: config.accountId,
      token: config.token,
      uid,
    });

    if (info?.status === "ready" && info.url) {
      if (VIDEO_DOWNLOAD_SHOULD_PROXY) {
        await streamRemoteDownloadToClient({
          res,
          sourceUrl: info.url,
          fileName: `${uid}.mp4`,
          defaultContentType: "video/mp4",
        });
        return;
      }

      return res.redirect(302, info.url);
    }

    return formatResponse({
      res,
      success: false,
      code: 202,
      message: "video download is being prepared, retry in a moment",
      body: {
        uid,
        status: info?.status ?? "inprogress",
        percent_complete: info?.percentComplete ?? null,
        retry_after_ms: 1500,
      },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: extractCloudflareError(error),
    });
  }
};

export const delete_audio_asset = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeAudioKey((req.params as any)?.uid) ??
    normalizeAudioKey((req.query as any)?.key);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid (or key) is required",
    });
  }

  try {
    const deleteUrl = buildR2PresignedUrl({
      method: "DELETE",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: 60,
    });
    const deleteResponse = await fetch(deleteUrl, { method: "DELETE" });
    if (!deleteResponse.ok) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: `audio delete failed (${deleteResponse.status})`,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, uid: objectKey, key: objectKey },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "audio delete failed",
    });
  }
};

export const delete_document_asset = async (req: Request, res: Response) => {
  const config = ensureR2Config();
  if (!config.ok) {
    return formatResponse({
      res,
      success: false,
      code: 500,
      message: config.message,
    });
  }

  const objectKey =
    normalizeDocumentKey((req.params as any)?.uid) ??
    normalizeDocumentKey((req.query as any)?.key) ??
    normalizeDocumentKey((req.query as any)?.uid);
  if (!objectKey) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "uid (or key) is required",
    });
  }

  try {
    const deleteUrl = buildR2PresignedUrl({
      method: "DELETE",
      bucket: config.bucket,
      endpoint: config.endpoint,
      key: objectKey,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds: 60,
    });
    const deleteResponse = await fetch(deleteUrl, { method: "DELETE" });
    if (!deleteResponse.ok) {
      return formatResponse({
        res,
        success: false,
        code: 502,
        message: `document delete failed (${deleteResponse.status})`,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { deleted: true, uid: objectKey, key: objectKey },
    });
  } catch (error: any) {
    return formatResponse({
      res,
      success: false,
      code: 502,
      message: error?.message ?? "document delete failed",
    });
  }
};
