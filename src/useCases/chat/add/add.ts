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

  if (messageType === "text") {
    if (!text) {
      return { ok: false, error: "message is required for text messages" };
    }
    return {
      ok: true,
      payload: {
        messageType: "text",
        text,
        mediaUrl: null,
        mediaMime: null,
        mediaDurationMs: null,
        mediaSizeBytes: null,
        waveform: null,
        metadata: null,
      },
      notificationPreview: text,
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
        metadata: contact,
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
        metadata: share,
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

  const mediaMetadata = parseMediaMetadata((body as any)?.metadata);

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
      metadata: mediaMetadata,
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
  const rawClientMessageId =
    (req.body as any)?.clientMessageId ?? (req.body as any)?.client_message_id;
  const hasClientMessageId =
    rawClientMessageId !== undefined &&
    rawClientMessageId !== null &&
    String(rawClientMessageId).trim() !== "";
  const clientMessageId = normalizeClientMessageId(rawClientMessageId);
  if (hasClientMessageId && !clientMessageId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "clientMessageId is invalid",
    });
  }
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

      messagePayload.metadata = hydratedContact;
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

    const rawPreview = payloadResult.notificationPreview.trim();
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

    const messages = await repository.getChatByUser(req.userId, receiverUserId);

    const payload = {
      chatId: messages.length > 0 ? messages[0].chatId : chatId,
      messages: serializeMessagesToCanonical(messages, { includeLegacy: true }),
    };

    return formatResponse({ res, success: true, body: payload });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error as any });
  }
};
