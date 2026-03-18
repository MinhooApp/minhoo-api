import {
  Request,
  Response,
  formatResponse,
  repository,
  sendNotification,
} from "../_module/module";
import {
  normalizeRemoteHttpUrl,
  resolveCloudflareImageUrlById,
} from "../../_utils/cloudflare_images";
import {
  emitChatMessageRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";
import User from "../../../_models/user/user";
import {
  serializeMessageToCanonical,
  serializeMessagesToCanonical,
} from "../_shared/message_contract";
import { createInMemoryRateLimiter } from "../../../libs/security/inmemory_rate_limiter";

type ChatMessageType =
  | "text"
  | "voice"
  | "image"
  | "video"
  | "document"
  | "contact"
  | "share";

type ContactMetadata = {
  user_id: number;
  name: string;
  avatar: string | null;
};

type ShareEntityType = "orbit_post" | "orbit_video" | "orbit_reel";

type ShareMetadata = {
  entity_type: ShareEntityType;
  entity_id: number;
  orbit_id: number | null;
  title: string | null;
  subtitle: string | null;
  thumbnail_url: string | null;
  preview_media_url: string | null;
};

export type MessagePayload = {
  messageType: ChatMessageType;
  text: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaDurationMs: number | null;
  mediaSizeBytes: number | null;
  waveform: number[] | null;
  metadata: Record<string, any> | null;
  clientMessageId?: string | null;
};

const VOICE_MAX_DURATION_MS = 60 * 1000;
const VOICE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_DURATION_MS = 60 * 1000;
const VIDEO_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const DOCUMENT_MAX_SIZE_BYTES = 20 * 1024 * 1024;
const WAVEFORM_MAX_POINTS = 256;
const CLIENT_MESSAGE_ID_MAX_LENGTH = 128;
const parsePositiveIntEnv = (value: any, fallback: number, min = 1): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.trunc(parsed));
};
const CHAT_SEND_RESPONSE_DEFAULT_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SEND_RESPONSE_DEFAULT_LIMIT ?? 20) || 20, 200)
);
const CHAT_SEND_RESPONSE_MAX_LIMIT = Math.max(
  CHAT_SEND_RESPONSE_DEFAULT_LIMIT,
  Math.min(Number(process.env.CHAT_SEND_RESPONSE_MAX_LIMIT ?? 50) || 50, 200)
);
const CHAT_SEND_RATE_WINDOW_MS = parsePositiveIntEnv(
  process.env.CHAT_SEND_RATE_WINDOW_MS,
  10_000,
  1000
);
const CHAT_SEND_RATE_MAX = parsePositiveIntEnv(process.env.CHAT_SEND_RATE_MAX, 30, 1);
const CHAT_SEND_RATE_BLOCK_MS = parsePositiveIntEnv(
  process.env.CHAT_SEND_RATE_BLOCK_MS,
  30_000,
  CHAT_SEND_RATE_WINDOW_MS
);
const chatSendRateLimiter = createInMemoryRateLimiter({
  windowMs: CHAT_SEND_RATE_WINDOW_MS,
  max: CHAT_SEND_RATE_MAX,
  blockDurationMs: CHAT_SEND_RATE_BLOCK_MS,
});

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

const isAllowedDocumentMime = (mime: string) => {
  if (DOCUMENT_ALLOWED_MIME_TYPES.has(mime)) return true;
  return mime.startsWith("text/");
};

const resolveAvatarUrl = (rawValue: string): string | null => {
  const remote = normalizeRemoteHttpUrl(rawValue);
  if (remote) return remote;
  if (rawValue.startsWith("/api/v1/media/image/play")) return rawValue;
  return null;
};

const resolveShareThumbnailUrl = (rawValue: string): string | null => {
  const remote = normalizeRemoteHttpUrl(rawValue);
  if (remote) return remote;
  if (rawValue.startsWith("/api/v1/media/image/play")) return rawValue;
  return null;
};

const resolveSharePreviewMediaUrl = (rawValue: string): string | null => {
  const remote = normalizeRemoteHttpUrl(rawValue);
  if (remote) return remote;
  if (rawValue.startsWith("/api/v1/media/image/play")) return rawValue;
  if (rawValue.startsWith("/api/v1/media/video/play")) return rawValue;
  return null;
};

const extractImageIdFromPlaybackMediaUrl = (rawValue: string): string | null => {
  try {
    const parsed = new URL(rawValue, "http://local");
    if (!parsed.pathname.includes("/api/v1/media/image/play")) return null;
    const imageIdRaw = String(parsed.searchParams.get("id") ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{6,255}$/.test(imageIdRaw)) return null;
    return imageIdRaw;
  } catch {
    return null;
  }
};

export const toInt = (v: any): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const toPositiveInt = (v: any): number | null => {
  const parsed = toInt(v);
  if (!parsed || parsed <= 0) return null;
  return parsed;
};

export const normalizeClientMessageId = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > CLIENT_MESSAGE_ID_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) return null;
  return normalized;
};

const resolveSendResponseLimit = (req: Request): number => {
  const body: any = req.body ?? {};
  const query: any = req.query ?? {};
  const candidateRaw =
    body?.response_messages_limit ??
    body?.responseMessagesLimit ??
    query?.response_messages_limit ??
    query?.responseMessagesLimit ??
    null;
  const parsed = toPositiveInt(candidateRaw);
  if (!parsed) return CHAT_SEND_RESPONSE_DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), CHAT_SEND_RESPONSE_MAX_LIMIT);
};

type ClientMessageIdCandidate = {
  source: string;
  rawValue: any;
};

const hasMeaningfulValue = (value: any): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
};

const normalizeOptionalBoolean = (value: any): boolean | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
};

const normalizeBoundedText = (
  value: any,
  maxLength: number
): string | null | undefined => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) return undefined;
  return normalized;
};

const parseE2eEnvelope = (value: any): Record<string, any> | null | undefined => {
  if (value === undefined || value === null || value === "") return null;

  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return null;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const version = normalizeBoundedText(
    (source as any)?.version ?? (source as any)?.v,
    16
  );
  const algorithm = normalizeBoundedText(
    (source as any)?.algorithm ?? (source as any)?.alg,
    64
  );
  const keyId = normalizeBoundedText((source as any)?.keyId ?? (source as any)?.kid, 255);
  const senderDeviceId = normalizeBoundedText(
    (source as any)?.senderDeviceId ?? (source as any)?.sender_device_id,
    255
  );
  const nonce = normalizeBoundedText(
    (source as any)?.nonce ?? (source as any)?.iv,
    512
  );
  const ciphertext = normalizeBoundedText(
    (source as any)?.ciphertext ?? (source as any)?.cipher,
    65535
  );
  const aad = normalizeBoundedText((source as any)?.aad, 8192);
  const encryptedRaw =
    (source as any)?.encrypted ?? (source as any)?.isEncrypted ?? (source as any)?.is_encrypted;
  const encrypted = normalizeOptionalBoolean(encryptedRaw);

  if (
    version === undefined ||
    algorithm === undefined ||
    keyId === undefined ||
    senderDeviceId === undefined ||
    nonce === undefined ||
    ciphertext === undefined ||
    aad === undefined
  ) {
    return undefined;
  }

  if (encryptedRaw !== undefined && encrypted === null) {
    return undefined;
  }

  const envelope: Record<string, any> = {
    encrypted: encrypted ?? true,
  };
  if (version) envelope.version = version;
  if (algorithm) envelope.algorithm = algorithm;
  if (keyId) envelope.keyId = keyId;
  if (senderDeviceId) envelope.senderDeviceId = senderDeviceId;
  if (nonce) envelope.nonce = nonce;
  if (ciphertext) envelope.ciphertext = ciphertext;
  if (aad) envelope.aad = aad;

  return envelope;
};

export const hasE2eMetadata = (metadata: any): boolean => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const envelope = (metadata as any)?._e2e ?? (metadata as any)?.e2e;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  return true;
};

const attachE2eMetadata = (
  metadata: Record<string, any> | null,
  body: any
): { ok: true; metadata: Record<string, any> | null } | { ok: false; error: string } => {
  const bodyEnvelopeRaw = (body as any)?._e2e ?? (body as any)?.e2e;
  const metadataEnvelopeRaw =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as any)?._e2e ?? (metadata as any)?.e2e
      : undefined;
  const envelopeRaw = hasMeaningfulValue(bodyEnvelopeRaw)
    ? bodyEnvelopeRaw
    : metadataEnvelopeRaw;

  if (!hasMeaningfulValue(envelopeRaw)) {
    return { ok: true, metadata };
  }

  const parsedEnvelope = parseE2eEnvelope(envelopeRaw);
  if (!parsedEnvelope) {
    return { ok: false, error: "_e2e is invalid" };
  }

  const baseMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...metadata }
      : {};
  baseMetadata._e2e = parsedEnvelope;
  if ("e2e" in baseMetadata) {
    delete (baseMetadata as any).e2e;
  }

  return { ok: true, metadata: baseMetadata };
};

export const mergePayloadWithE2eMetadata = (
  payloadMetadata: Record<string, any> | null,
  sourceMetadata: Record<string, any> | null
): Record<string, any> | null => {
  if (!hasE2eMetadata(sourceMetadata)) return payloadMetadata;

  const e2e = (sourceMetadata as any)._e2e ?? (sourceMetadata as any).e2e;
  const baseMetadata =
    payloadMetadata && typeof payloadMetadata === "object" && !Array.isArray(payloadMetadata)
      ? { ...payloadMetadata }
      : {};
  baseMetadata._e2e = e2e;
  return baseMetadata;
};

export const resolveClientMessageIdFromRequest = (
  req: Request
):
  | { ok: true; clientMessageId: string | null; source: string | null }
  | { ok: false; code: number; message: string } => {
  const candidates: ClientMessageIdCandidate[] = [
    { source: "clientMessageId", rawValue: (req.body as any)?.clientMessageId },
    { source: "client_message_id", rawValue: (req.body as any)?.client_message_id },
    { source: "idempotencyKey", rawValue: (req.body as any)?.idempotencyKey },
    { source: "idempotency_key", rawValue: (req.body as any)?.idempotency_key },
    { source: "Idempotency-Key", rawValue: req.header("Idempotency-Key") },
    { source: "X-Idempotency-Key", rawValue: req.header("X-Idempotency-Key") },
  ];

  const provided = candidates.filter((candidate) => hasMeaningfulValue(candidate.rawValue));
  if (!provided.length) {
    return { ok: true, clientMessageId: null, source: null };
  }

  const normalizedCandidates = provided.map((candidate) => ({
    source: candidate.source,
    normalized: normalizeClientMessageId(candidate.rawValue),
  }));
  const invalid = normalizedCandidates.find((candidate) => !candidate.normalized);
  if (invalid) {
    return { ok: false, code: 400, message: `${invalid.source} is invalid` };
  }

  const distinctNormalized = new Set(normalizedCandidates.map((candidate) => candidate.normalized));
  if (distinctNormalized.size > 1) {
    return {
      ok: false,
      code: 409,
      message: "idempotency key mismatch between body/header values",
    };
  }

  return {
    ok: true,
    clientMessageId: normalizedCandidates[0]?.normalized ?? null,
    source: normalizedCandidates[0]?.source ?? null,
  };
};

const parseContactMetadata = (value: any): ContactMetadata | undefined => {
  if (value == null || value === "") return undefined;

  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return undefined;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const userId =
    toPositiveInt((source as any)?.user_id) ??
    toPositiveInt((source as any)?.userId) ??
    toPositiveInt((source as any)?.id);
  if (!userId) return undefined;

  const name = String((source as any)?.name ?? "")
    .trim()
    .replace(/\s+/g, " ");

  const avatarRaw = String(
    (source as any)?.avatar ??
      (source as any)?.avatar_url ??
      (source as any)?.image ??
      ""
  ).trim();
  const avatar = avatarRaw ? resolveAvatarUrl(avatarRaw) : null;
  if (avatarRaw && !avatar) return undefined;

  return {
    user_id: userId,
    name,
    avatar: avatar ?? null,
  };
};

const normalizeShareEntityType = (value: any): ShareEntityType | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "orbit_post" ||
    normalized === "orbit_video" ||
    normalized === "orbit_reel"
  ) {
    return normalized;
  }
  return null;
};

const normalizeShareText = (
  value: any,
  maxLength: number
): string | null | undefined => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > maxLength) return undefined;
  return normalized;
};

const parseShareMetadata = (value: any): ShareMetadata | undefined => {
  if (value == null || value === "") return undefined;

  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return undefined;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const entityType = normalizeShareEntityType(
    (source as any)?.entity_type ??
      (source as any)?.entityType ??
      (source as any)?.content_type ??
      (source as any)?.contentType ??
      (source as any)?.type
  );
  const entityId =
    toPositiveInt((source as any)?.entity_id) ??
    toPositiveInt((source as any)?.entityId) ??
    toPositiveInt((source as any)?.content_id) ??
    toPositiveInt((source as any)?.contentId) ??
    toPositiveInt((source as any)?.id);

  if (!entityType || !entityId) return undefined;

  const orbitId =
    toPositiveInt((source as any)?.orbit_id) ??
    toPositiveInt((source as any)?.orbitId) ??
    null;

  const title = normalizeShareText(
    (source as any)?.title ?? (source as any)?.name,
    120
  );
  if (title === undefined) return undefined;

  const subtitle = normalizeShareText(
    (source as any)?.subtitle ??
      (source as any)?.description ??
      (source as any)?.caption ??
      (source as any)?.text,
    220
  );
  if (subtitle === undefined) return undefined;

  const thumbnailRaw = String(
    (source as any)?.thumbnail_url ??
      (source as any)?.thumbnailUrl ??
      (source as any)?.thumbnail ??
      ""
  ).trim();
  const thumbnailUrl = thumbnailRaw
    ? resolveShareThumbnailUrl(thumbnailRaw)
    : null;
  if (thumbnailRaw && !thumbnailUrl) return undefined;

  const previewMediaRaw = String(
    (source as any)?.preview_media_url ??
      (source as any)?.previewMediaUrl ??
      (source as any)?.media_url ??
      (source as any)?.mediaUrl ??
      ""
  ).trim();
  const previewMediaUrl = previewMediaRaw
    ? resolveSharePreviewMediaUrl(previewMediaRaw)
    : null;
  if (previewMediaRaw && !previewMediaUrl) return undefined;

  return {
    entity_type: entityType,
    entity_id: entityId,
    orbit_id: orbitId,
    title: title ?? null,
    subtitle: subtitle ?? null,
    thumbnail_url: thumbnailUrl ?? null,
    preview_media_url: previewMediaUrl ?? null,
  };
};

const parseMessageType = (value: any): ChatMessageType | null => {
  const normalized = String(value ?? "text").trim().toLowerCase();
  if (!normalized) return "text";
  if (
    normalized === "text" ||
    normalized === "voice" ||
    normalized === "image" ||
    normalized === "video" ||
    normalized === "document" ||
    normalized === "contact" ||
    normalized === "share"
  ) {
    return normalized as ChatMessageType;
  }
  return null;
};

const resolveChatMediaUrl = async (
  messageType: Exclude<ChatMessageType, "text" | "contact" | "share">,
  rawValue: string
): Promise<string | null> => {
  if (messageType === "image") {
    const imageId = extractImageIdFromPlaybackMediaUrl(rawValue);
    if (imageId) {
      const resolvedDirectUrl = await resolveCloudflareImageUrlById(imageId);
      if (resolvedDirectUrl) return resolvedDirectUrl;
    }
  }

  const remote = normalizeRemoteHttpUrl(rawValue);
  if (remote) return remote;

  if (messageType === "voice" && rawValue.startsWith("/api/v1/media/audio/play")) {
    return rawValue;
  }
  if (messageType === "image" && rawValue.startsWith("/api/v1/media/image/play")) {
    return rawValue;
  }
  if (messageType === "video" && rawValue.startsWith("/api/v1/media/video/play")) {
    return rawValue;
  }
  if (
    messageType === "document" &&
    rawValue.startsWith("/api/v1/media/document/download")
  ) {
    return rawValue;
  }

  return null;
};

const parseWaveform = (value: any): number[] | null | undefined => {
  if (value === undefined || value === null || value === "") return null;

  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return null;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!Array.isArray(source)) return undefined;
  const out = source
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry))
    .slice(0, WAVEFORM_MAX_POINTS);

  return out.length ? out : null;
};

const parseMediaMetadata = (value: any): Record<string, any> | null => {
  if (value === undefined || value === null || value === "") return null;

  let source = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return null;
    try {
      source = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return source as Record<string, any>;
};

export const buildMessagePayload = async (
  body: any
): Promise<
  { ok: true; payload: MessagePayload; notificationPreview: string } | { ok: false; error: string }
> => {
  const messageType =
    parseMessageType((body as any)?.message_type ?? (body as any)?.messageType) ??
    null;
  if (!messageType) {
    return {
      ok: false,
      error:
        "message_type must be text, voice, image, video, document, contact or share",
    };
  }

  const text = String((body as any)?.message ?? "").trim();
  const metadataResult = attachE2eMetadata(parseMediaMetadata((body as any)?.metadata), body);
  if (!metadataResult.ok) {
    return {
      ok: false,
      error: metadataResult.error,
    };
  }
  const metadataWithE2e = metadataResult.metadata;

  if (messageType === "text") {
    const encryptedMessage = hasE2eMetadata(metadataWithE2e);
    if (!text && !encryptedMessage) {
      return { ok: false, error: "message is required for text messages" };
    }
    return {
      ok: true,
      payload: {
        messageType: "text",
        text: text || null,
        mediaUrl: null,
        mediaMime: null,
        mediaDurationMs: null,
        mediaSizeBytes: null,
        waveform: null,
        metadata: metadataWithE2e,
      },
      notificationPreview: encryptedMessage ? "🔐 Encrypted message" : text,
    };
  }

  if (messageType === "contact") {
    const contact =
      parseContactMetadata((body as any)?.contact) ??
      parseContactMetadata((body as any)?.contact_payload) ??
      parseContactMetadata((body as any)?.contactPayload) ??
      parseContactMetadata((body as any)?.metadata);

    if (!contact) {
      return {
        ok: false,
        error: "contact.user_id is required",
      };
    }

    return {
      ok: true,
      payload: {
        messageType: "contact",
        text: text || null,
        mediaUrl: null,
        mediaMime: null,
        mediaDurationMs: null,
        mediaSizeBytes: null,
        waveform: null,
        metadata: mergePayloadWithE2eMetadata(contact, metadataWithE2e),
      },
      notificationPreview: "👤 Profile",
    };
  }

  if (messageType === "share") {
    const share =
      parseShareMetadata((body as any)?.share) ??
      parseShareMetadata((body as any)?.share_payload) ??
      parseShareMetadata((body as any)?.sharePayload) ??
      parseShareMetadata((body as any)?.metadata);

    if (!share) {
      return {
        ok: false,
        error: "share.entity_type and share.entity_id are required",
      };
    }

    const previewTitle = (share.title ?? share.subtitle ?? "").trim();
    return {
      ok: true,
      payload: {
        messageType: "share",
        text: text || null,
        mediaUrl: null,
        mediaMime: null,
        mediaDurationMs: null,
        mediaSizeBytes: null,
        waveform: null,
        metadata: mergePayloadWithE2eMetadata(share, metadataWithE2e),
      },
      notificationPreview: previewTitle
        ? `🔗 ${previewTitle}`
        : "🔗 Orbit publication",
    };
  }

  const mediaUrlRaw = String(
    (body as any)?.media_url ?? (body as any)?.mediaUrl ?? ""
  ).trim();
  const mediaUrl = await resolveChatMediaUrl(messageType, mediaUrlRaw);

  if (!mediaUrl) {
    if (messageType === "voice") {
      return {
        ok: false,
        error:
          "media_url must be a valid http(s) URL or /api/v1/media/audio/play path for voice messages",
      };
    }
    if (messageType === "image") {
      return {
        ok: false,
        error:
          "media_url must be a valid http(s) URL or /api/v1/media/image/play path for image messages",
      };
    }
    if (messageType === "video") {
      return {
        ok: false,
        error:
          "media_url must be a valid http(s) URL or /api/v1/media/video/play path for video messages",
      };
    }
    if (messageType === "document") {
      return {
        ok: false,
        error:
          "media_url must be a valid http(s) URL or /api/v1/media/document/download path for document messages",
      };
    }
    return {
      ok: false,
      error: `media_url must be a valid http(s) URL for ${messageType} messages`,
    };
  }

  const mediaMimeRaw = String(
    (body as any)?.media_mime ?? (body as any)?.mediaMime ?? ""
  )
    .trim()
    .toLowerCase();
  const mediaMime = mediaMimeRaw || null;

  if (messageType === "voice" && mediaMime && !mediaMime.startsWith("audio/")) {
    return { ok: false, error: "media_mime must be an audio/* mime type" };
  }

  if (messageType === "image" && mediaMime && !mediaMime.startsWith("image/")) {
    return { ok: false, error: "media_mime must be an image/* mime type" };
  }

  if (
    messageType === "video" &&
    mediaMime &&
    !mediaMime.startsWith("video/") &&
    mediaMime !== "application/x-mpegurl" &&
    mediaMime !== "application/vnd.apple.mpegurl"
  ) {
    return {
      ok: false,
      error: "media_mime must be a video/* or HLS mime type",
    };
  }

  if (messageType === "document" && mediaMime && !isAllowedDocumentMime(mediaMime)) {
    return {
      ok: false,
      error: "media_mime must be a valid document mime type",
    };
  }

  const mediaDurationMs = toPositiveInt(
    (body as any)?.media_duration_ms ?? (body as any)?.mediaDurationMs
  );
  if (messageType === "voice" && mediaDurationMs !== null && mediaDurationMs > VOICE_MAX_DURATION_MS) {
    return { ok: false, error: `voice duration exceeds ${VOICE_MAX_DURATION_MS} ms` };
  }
  if (messageType === "video" && mediaDurationMs !== null && mediaDurationMs > VIDEO_MAX_DURATION_MS) {
    return { ok: false, error: `video duration exceeds ${VIDEO_MAX_DURATION_MS} ms` };
  }

  const mediaSizeBytes = toPositiveInt(
    (body as any)?.media_size_bytes ?? (body as any)?.mediaSizeBytes
  );
  if (messageType === "voice" && mediaSizeBytes !== null && mediaSizeBytes > VOICE_MAX_SIZE_BYTES) {
    return { ok: false, error: `voice size exceeds ${VOICE_MAX_SIZE_BYTES} bytes` };
  }
  if (messageType === "image" && mediaSizeBytes !== null && mediaSizeBytes > IMAGE_MAX_SIZE_BYTES) {
    return { ok: false, error: `image size exceeds ${IMAGE_MAX_SIZE_BYTES} bytes` };
  }
  if (messageType === "video" && mediaSizeBytes !== null && mediaSizeBytes > VIDEO_MAX_SIZE_BYTES) {
    return { ok: false, error: `video size exceeds ${VIDEO_MAX_SIZE_BYTES} bytes` };
  }
  if (
    messageType === "document" &&
    mediaSizeBytes !== null &&
    mediaSizeBytes > DOCUMENT_MAX_SIZE_BYTES
  ) {
    return {
      ok: false,
      error: `document size exceeds ${DOCUMENT_MAX_SIZE_BYTES} bytes`,
    };
  }

  const waveform =
    messageType === "voice" ? parseWaveform((body as any)?.waveform) : null;
  if (waveform === undefined) {
    return { ok: false, error: "waveform must be an array of numbers" };
  }

  const notificationPreviewByType: Record<
    Exclude<ChatMessageType, "text" | "contact" | "share">,
    string
  > = {
    voice: "🎤 Voice message",
    image: "📷 Photo",
    video: "🎬 Video",
    document: "📄 Document",
  };

  return {
    ok: true,
    payload: {
      messageType,
      text: text || null,
      mediaUrl,
      mediaMime,
      mediaDurationMs,
      mediaSizeBytes,
      waveform,
      metadata: metadataWithE2e,
    },
    notificationPreview: notificationPreviewByType[messageType],
  };
};

const buildFullName = (sender: any): string => {
  if (!sender) return "";

  const firstName = (sender.name ?? sender.firstName ?? sender.firstname ?? "")
    .toString()
    .trim();

  const lastName = (
    sender.lastName ??
    sender.lastname ??
    sender.surname ??
    sender.last_name ??
    ""
  )
    .toString()
    .trim();

  const combined = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (combined) return combined;

  const fullName = (sender.fullName ?? sender.userName ?? sender.username ?? "")
    .toString()
    .trim();

  return fullName;
};

const buildSenderTitle = (_senderId: number, fullName: string): string => {
  const name = (fullName || "").trim();
  return name ? name : "Nuevo mensaje";
};

const buildProfileFullName = (user: any): string => {
  const firstName = String(user?.name ?? "").trim();
  const lastName = String(user?.last_name ?? "").trim();
  return [firstName, lastName].filter(Boolean).join(" ").trim();
};

export const hydrateContactMetadata = async (
  raw: ContactMetadata | null
): Promise<ContactMetadata | null> => {
  if (!raw) return null;

  const userId = toPositiveInt(raw.user_id);
  if (!userId) return null;

  const user = await User.findByPk(userId, {
    attributes: ["id", "name", "last_name", "username", "image_profil", "is_deleted"],
  });
  if (!user || (user as any)?.is_deleted) return null;

  const resolvedUserId = Number((user as any).id);
  const fullName = buildProfileFullName(user);
  const username = String((user as any)?.username ?? "").trim();
  const fallbackName = username || `User ${resolvedUserId}`;
  const avatarRaw = String((user as any)?.image_profil ?? "").trim();
  const avatarResolved = avatarRaw ? resolveAvatarUrl(avatarRaw) : null;

  return {
    user_id: resolvedUserId,
    name: fullName || fallbackName,
    avatar: avatarResolved ?? null,
  };
};

export const sendMessage = async (req: Request, res: Response) => {
  const receiverUserId = toPositiveInt(req.body.userId);
  if (!receiverUserId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "userId must be a valid id",
    });
  }
  const senderUserId = Number(req.userId ?? 0);
  if (Number.isFinite(senderUserId) && senderUserId > 0) {
    const limitResult = chatSendRateLimiter.consume(`chat:http:send:${senderUserId}`);
    if (!limitResult.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(limitResult.retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return formatResponse({
        res,
        success: false,
        code: 429,
        islogin: true,
        message: `Too many messages. Please retry in ${retryAfterSeconds}s.`,
      });
    }
  }

  const payloadResult = await buildMessagePayload(req.body);
  if (!payloadResult.ok) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: payloadResult.error,
    });
  }

  const messagePayload = payloadResult.payload;
  const resolvedClientMessageId = resolveClientMessageIdFromRequest(req);
  if (!resolvedClientMessageId.ok) {
    return formatResponse({
      res,
      success: false,
      code: resolvedClientMessageId.code,
      message: resolvedClientMessageId.message,
    });
  }
  const clientMessageId = resolvedClientMessageId.clientMessageId;
  const clientMessageIdSource = resolvedClientMessageId.source;
  if (clientMessageId) {
    messagePayload.clientMessageId = clientMessageId;
  }

  // ✅ aceptar reply (camelCase + snake_case)
  const replyToMessageId =
    toInt(req.body.replyToMessageId) ?? toInt(req.body.reply_to_message_id);

  try {
    if (messagePayload.messageType === "contact") {
      const hydratedContact = await hydrateContactMetadata(
        (messagePayload.metadata as ContactMetadata | null) ?? null
      );

      if (!hydratedContact) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "contact is invalid. Send a valid contact.user_id",
        });
      }

      messagePayload.metadata = mergePayloadWithE2eMetadata(
        hydratedContact as any,
        messagePayload.metadata as any
      );
    }

    const flag = await repository.validateBlock(req.userId, receiverUserId);

    if (flag) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "cannot send message to this user",
      });
    }

    const created = await repository.initNewChat(
      req.userId,
      receiverUserId,
      messagePayload,
      replyToMessageId
    );

    if (!created || !created.chatId || !created.messageId) {
      return formatResponse({
        res,
        success: false,
        message: "No se pudo enviar el mensaje",
      });
    }

    const chatId = Number((created as any).chatId);
    const createdMessageId = Number((created as any).messageId);
    const wasDeduplicated = Boolean((created as any).deduplicated);
    const fullMessage = await repository.getSenderByMessageId(
      createdMessageId,
      req.userId
    );
    if (!fullMessage) {
      return formatResponse({
        res,
        success: false,
        message: "No se pudo cargar el mensaje enviado",
      });
    }

    if (replyToMessageId != null) {
      (fullMessage as any).replyToMessageId ??= replyToMessageId;
      (fullMessage as any).reply_to_message_id ??= replyToMessageId;

      if (!(fullMessage as any).replyTo) {
        (fullMessage as any).replyTo = null;
      }
    }

    const serializedMessage = serializeMessageToCanonical(fullMessage, {
      includeLegacy: true,
    });

    if (!wasDeduplicated) {
      emitChatMessageRealtime(chatId, serializedMessage, [req.userId, receiverUserId]);
      emitChatsRefreshRealtime(receiverUserId);
      emitChatsRefreshRealtime(req.userId);
    }

    const senderId = req.userId;
    const senderFromMessage = (serializedMessage as any)?.sender;

    let fullName = buildFullName(senderFromMessage);
    if (!fullName || fullName.split(" ").length < 2) {
      try {
        const me =
          (repository as any).getUserById?.(senderId) ??
          (repository as any).getUser?.(senderId) ??
          (repository as any).findUserById?.(senderId);

        const resolved = await me;
        if (resolved) {
          const fixed = buildFullName(resolved);
          if (fixed) fullName = fixed;
        }
      } catch (_) {
        // ignore fallback errors
      }
    }

    const senderName = buildSenderTitle(senderId, fullName || "Nuevo mensaje");

    const encryptedMessage = hasE2eMetadata(
      (serializedMessage as any)?.metadata ?? messagePayload.metadata
    );
    const rawPreview = encryptedMessage
      ? "🔐 Encrypted message"
      : payloadResult.notificationPreview.trim();
    const snippet =
      rawPreview.length > 60 ? `${rawPreview.slice(0, 60)}...` : rawPreview;
    const notificationBody = snippet || "You have a new message";

    // Push/notification must never block nor fail the message send response.
    if (!wasDeduplicated) {
      void sendNotification({
        userId: receiverUserId,
        interactorId: senderId,
        chatId,
        messageId: createdMessageId,
        type: "message",
        message: notificationBody,
        senderName,
        notificationScope: "direct",
        peerUserId: senderId,
      }).catch((pushError) => {
        console.warn(
          `[chat][sendMessage] notification dispatch failed chatId=${chatId} messageId=${createdMessageId} senderId=${senderId} receiverUserId=${receiverUserId}`,
          pushError
        );
      });
    }

    const responseMessagesLimit = resolveSendResponseLimit(req);
    const messages = await repository.getChatByUser(req.userId, receiverUserId, {
      limit: responseMessagesLimit,
      sort: "asc",
    });
    const responseClientMessageId =
      normalizeClientMessageId(
        (serializedMessage as any)?.clientMessageId ?? (serializedMessage as any)?.client_message_id
      ) ?? clientMessageId;

    const payload = {
      chatId: messages.length > 0 ? messages[0].chatId : chatId,
      messages: serializeMessagesToCanonical(messages, { includeLegacy: true }),
      paging: {
        limit: responseMessagesLimit,
        messages_truncated: messages.length >= responseMessagesLimit,
        messagesTruncated: messages.length >= responseMessagesLimit,
      },
      deduplicated: wasDeduplicated,
      clientMessageId: responseClientMessageId,
      client_message_id: responseClientMessageId,
      idempotencyKey: responseClientMessageId,
      idempotency_key: responseClientMessageId,
      idempotencySource: clientMessageIdSource,
      idempotency_source: clientMessageIdSource,
    };

    return formatResponse({ res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error as any });
  }
};
