import { AppLocale } from "../../../libs/localization/locale";
import { formatRelativeTime } from "../../../libs/localization/relative_time";

const toPlain = (value: any) =>
  value && typeof value.toJSON === "function" ? value.toJSON() : value ?? {};

const toText = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length ? normalized : null;
};

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const toDateValue = (value: any): Date | string | null => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const normalizeVideoUid = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  return normalized;
};

const normalizeVideoStorageKey = (value: any): string | null => {
  if (value === undefined || value === null) return null;
  const normalized = decodeURIComponent(String(value).trim());
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return null;
  return normalized;
};

const extractVideoUidFromMediaUrl = (rawUrl: string | null): string | null => {
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl, "http://local");
    const uidFromQuery = normalizeVideoUid(parsed.searchParams.get("uid"));
    if (uidFromQuery) return uidFromQuery;

    const path = parsed.pathname || "";
    const pathUidMatch = path.match(/\/([a-f0-9]{32})(?:\/|$)/i);
    if (pathUidMatch?.[1]) {
      const uidFromPath = normalizeVideoUid(pathUidMatch[1]);
      if (uidFromPath) return uidFromPath;
    }
  } catch {
    return null;
  }

  return null;
};

const extractVideoKeyFromMediaUrl = (rawUrl: string | null): string | null => {
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl, "http://local");
    const keyFromQuery = normalizeVideoStorageKey(parsed.searchParams.get("key"));
    if (keyFromQuery) return keyFromQuery;

    const uidRaw = String(parsed.searchParams.get("uid") ?? "").trim();
    if (uidRaw && !normalizeVideoUid(uidRaw)) {
      return normalizeVideoStorageKey(uidRaw);
    }
  } catch {
    return null;
  }

  return null;
};

const buildVideoDownloadPath = (uid: string) =>
  `/api/v1/media/video/download?uid=${encodeURIComponent(uid)}`;
const buildR2VideoDownloadPath = (key: string) =>
  `/api/v1/media/video/download?key=${encodeURIComponent(key)}`;

const buildVideoThumbnailUrl = (uid: string) =>
  `https://videodelivery.net/${encodeURIComponent(uid)}/thumbnails/thumbnail.jpg?time=1s`;

const parseMetadataObject = (value: any): Record<string, any> | null => {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      return null;
    }
  }
  return null;
};

const toPositiveNumber = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0) return null;
  return Math.trunc(parsed);
};

const toBooleanOrNull = (value: any): boolean | null => {
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

const toBoundedText = (value: any, maxLength: number): string | null => {
  const text = toText(value);
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
};

const resolveVideoDownloadUrl = (message: any, mediaUrl: string | null): string | null => {
  const explicitDownloadUrl = toText(
    (message as any)?.mediaDownloadUrl ?? (message as any)?.media_download_url
  );
  if (explicitDownloadUrl) return explicitDownloadUrl;

  const uid = extractVideoUidFromMediaUrl(mediaUrl);
  if (uid) return buildVideoDownloadPath(uid);

  const key = extractVideoKeyFromMediaUrl(mediaUrl);
  if (key) return buildR2VideoDownloadPath(key);

  return null;
};

const resolveVideoThumbnailFields = (
  message: any,
  mediaUrl: string | null
): {
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  thumbnailBlurhash: string | null;
  thumbnailVersion: number | null;
} => {
  const metadata = parseMetadataObject((message as any)?.metadata);

  const explicitThumbnailUrl =
    toText((message as any)?.thumbnailUrl) ??
    toText((message as any)?.thumbnail_url) ??
    toText((metadata as any)?.thumbnailUrl) ??
    toText((metadata as any)?.thumbnail_url) ??
    toText((metadata as any)?.thumbnail) ??
    toText((metadata as any)?.posterUrl) ??
    toText((metadata as any)?.poster_url) ??
    toText((metadata as any)?.poster);

  const thumbnailWidth =
    toPositiveNumber((message as any)?.thumbnailWidth) ??
    toPositiveNumber((message as any)?.thumbnail_width) ??
    toPositiveNumber((metadata as any)?.thumbnailWidth) ??
    toPositiveNumber((metadata as any)?.thumbnail_width);

  const thumbnailHeight =
    toPositiveNumber((message as any)?.thumbnailHeight) ??
    toPositiveNumber((message as any)?.thumbnail_height) ??
    toPositiveNumber((metadata as any)?.thumbnailHeight) ??
    toPositiveNumber((metadata as any)?.thumbnail_height);

  const thumbnailBlurhash =
    toText((message as any)?.thumbnailBlurhash) ??
    toText((message as any)?.thumbnail_blurhash) ??
    toText((metadata as any)?.thumbnailBlurhash) ??
    toText((metadata as any)?.thumbnail_blurhash) ??
    toText((metadata as any)?.blurhash);

  const thumbnailVersion =
    toPositiveNumber((message as any)?.thumbnailVersion) ??
    toPositiveNumber((message as any)?.thumbnail_version) ??
    toPositiveNumber((metadata as any)?.thumbnailVersion) ??
    toPositiveNumber((metadata as any)?.thumbnail_version);

  if (explicitThumbnailUrl) {
    return {
      thumbnailUrl: explicitThumbnailUrl,
      thumbnailWidth,
      thumbnailHeight,
      thumbnailBlurhash,
      thumbnailVersion,
    };
  }

  const uid = extractVideoUidFromMediaUrl(mediaUrl);
  return {
    thumbnailUrl: uid ? buildVideoThumbnailUrl(uid) : null,
    thumbnailWidth,
    thumbnailHeight,
    thumbnailBlurhash,
    thumbnailVersion,
  };
};

const resolveClientMessageId = (message: any): string | null => {
  const fromField = toText(
    (message as any)?.clientMessageId ?? (message as any)?.client_message_id
  );
  if (fromField) return fromField;

  const metadata = (message as any)?.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return toText((metadata as any)?._clientMessageId) ?? toText((metadata as any)?.clientMessageId);
  }

  return null;
};

const resolveContact = (message: any): Record<string, any> | null => {
  const messageType = toText((message as any)?.messageType)?.toLowerCase();
  if (messageType !== "contact") return null;

  const fromContact = (message as any)?.contact;
  if (fromContact && typeof fromContact === "object" && !Array.isArray(fromContact)) {
    return fromContact;
  }

  const metadata = (message as any)?.metadata;
  if (!metadata) return null;

  if (typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata;
  }

  if (typeof metadata === "string") {
    const trimmed = metadata.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
};

const resolveShare = (message: any): Record<string, any> | null => {
  const messageType = toText((message as any)?.messageType)?.toLowerCase();
  if (messageType !== "share") return null;

  const fromShare = (message as any)?.share;
  if (fromShare && typeof fromShare === "object" && !Array.isArray(fromShare)) {
    return fromShare;
  }

  const metadata = (message as any)?.metadata;
  if (!metadata) return null;

  if (typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata;
  }

  if (typeof metadata === "string") {
    const trimmed = metadata.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
};

const resolveE2eEnvelope = (message: any): Record<string, any> | null => {
  const metadata = parseMetadataObject((message as any)?.metadata);
  if (!metadata) return null;

  const source = (metadata as any)?._e2e ?? (metadata as any)?.e2e;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }

  const encrypted =
    toBooleanOrNull(
      (source as any)?.encrypted ??
        (source as any)?.isEncrypted ??
        (source as any)?.is_encrypted
    ) ?? true;

  const envelope: Record<string, any> = {
    encrypted,
  };

  const version = toBoundedText((source as any)?.version ?? (source as any)?.v, 16);
  const algorithm = toBoundedText((source as any)?.algorithm ?? (source as any)?.alg, 64);
  const keyId = toBoundedText((source as any)?.keyId ?? (source as any)?.kid, 255);
  const senderDeviceId = toBoundedText(
    (source as any)?.senderDeviceId ?? (source as any)?.sender_device_id,
    255
  );
  const nonce = toBoundedText((source as any)?.nonce ?? (source as any)?.iv, 512);
  const ciphertext = toBoundedText((source as any)?.ciphertext ?? (source as any)?.cipher, 65535);
  const aad = toBoundedText((source as any)?.aad, 8192);

  if (version) envelope.version = version;
  if (algorithm) envelope.algorithm = algorithm;
  if (keyId) envelope.keyId = keyId;
  if (senderDeviceId) envelope.senderDeviceId = senderDeviceId;
  if (nonce) envelope.nonce = nonce;
  if (ciphertext) envelope.ciphertext = ciphertext;
  if (aad) envelope.aad = aad;

  return envelope;
};

const resolveSenderFields = (message: any) => {
  const sender = toPlain((message as any)?.sender);
  const senderId =
    toPositiveInt((message as any)?.senderId) ??
    toPositiveInt((sender as any)?.id) ??
    0;

  const senderNameFromPayload = toText(
    (message as any)?.senderName ?? (message as any)?.sender_name
  );
  const senderUsername =
    toText((sender as any)?.username) ??
    toText((message as any)?.senderUsername ?? (message as any)?.sender_username);
  const firstName = toText((sender as any)?.name);
  const lastName = toText((sender as any)?.last_name ?? (sender as any)?.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const senderName = senderNameFromPayload ?? (fullName || senderUsername);
  const senderAvatarUrl =
    toText((sender as any)?.image_profil) ??
    toText((sender as any)?.avatarUrl) ??
    toText((sender as any)?.avatar_url) ??
    toText((message as any)?.senderAvatarUrl ?? (message as any)?.sender_avatar_url);

  return {
    sender: (message as any)?.sender ?? sender ?? null,
    senderId,
    senderName,
    senderUsername,
    senderAvatarUrl,
  };
};

export type CanonicalChatMessage = {
  id: number;
  chatId: number;
  senderId: number;
  text: string | null;
  messageType: string;
  mediaUrl: string | null;
  mediaDownloadUrl: string | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  thumbnailBlurhash: string | null;
  thumbnailVersion: number | null;
  clientMessageId: string | null;
  mediaMime: string | null;
  date: Date | string | null;
  status: string | null;
  deliveredAt: Date | string | null;
  readAt: Date | string | null;
  replyToMessageId: number | null;
  contact: Record<string, any> | null;
  share: Record<string, any> | null;
  senderName: string | null;
  senderUsername: string | null;
  senderAvatarUrl: string | null;
  relativeTime: string | null;
  relative_time: string | null;
  relativeTimeEn: string | null;
  relative_time_en: string | null;
  relativeTimeEs: string | null;
  relative_time_es: string | null;
  isEncrypted: boolean;
  is_encrypted: boolean;
  e2e: Record<string, any> | null;
};

export const serializeMessageToCanonical = (
  value: any,
  opts?: { includeLegacy?: boolean; locale?: AppLocale }
) => {
  const message = toPlain(value);
  const senderFields = resolveSenderFields(message);
  const messageType = toText((message as any)?.messageType) ?? "text";
  const mediaUrl = toText((message as any)?.mediaUrl);
  const isVideo = messageType.toLowerCase() === "video";

  const mediaDownloadUrl = isVideo ? resolveVideoDownloadUrl(message, mediaUrl) : null;
  const videoThumbnail = isVideo
    ? resolveVideoThumbnailFields(message, mediaUrl)
    : {
        thumbnailUrl: null,
        thumbnailWidth: null,
        thumbnailHeight: null,
        thumbnailBlurhash: null,
        thumbnailVersion: null,
      };

  const clientMessageId = resolveClientMessageId(message);
  const relativeTimeEn = formatRelativeTime(
    (message as any)?.date ?? (message as any)?.createdAt ?? (message as any)?.updatedAt,
    "en"
  );
  const relativeTimeEs = formatRelativeTime(
    (message as any)?.date ?? (message as any)?.createdAt ?? (message as any)?.updatedAt,
    "es"
  );
  const preferredLocale = opts?.locale ?? "en";
  const relativeTime = preferredLocale === "es" ? relativeTimeEs : relativeTimeEn;
  const e2e = resolveE2eEnvelope(message);
  const isEncrypted = Boolean(e2e?.encrypted ?? e2e);

  const canonical: CanonicalChatMessage = {
    id: toPositiveInt((message as any)?.id) ?? 0,
    chatId:
      toPositiveInt((message as any)?.chatId) ??
      toPositiveInt((message as any)?.chat_id) ??
      0,
    senderId: senderFields.senderId,
    text: toText((message as any)?.text),
    messageType,
    mediaUrl,
    mediaDownloadUrl,
    thumbnailUrl: videoThumbnail.thumbnailUrl,
    thumbnailWidth: videoThumbnail.thumbnailWidth,
    thumbnailHeight: videoThumbnail.thumbnailHeight,
    thumbnailBlurhash: videoThumbnail.thumbnailBlurhash,
    thumbnailVersion: videoThumbnail.thumbnailVersion,
    clientMessageId,
    mediaMime: toText((message as any)?.mediaMime),
    date: toDateValue((message as any)?.date),
    status: toText((message as any)?.status),
    deliveredAt: toDateValue((message as any)?.deliveredAt),
    readAt: toDateValue((message as any)?.readAt),
    replyToMessageId: toPositiveInt((message as any)?.replyToMessageId),
    contact: resolveContact(message),
    share: resolveShare(message),
    senderName: senderFields.senderName,
    senderUsername: senderFields.senderUsername,
    senderAvatarUrl: senderFields.senderAvatarUrl,
    relativeTime,
    relative_time: relativeTime,
    relativeTimeEn,
    relative_time_en: relativeTimeEn,
    relativeTimeEs,
    relative_time_es: relativeTimeEs,
    isEncrypted,
    is_encrypted: isEncrypted,
    e2e,
  };

  const isVideoMessage = canonical.messageType.toLowerCase() === "video";
  const baseMetadata = parseMetadataObject((message as any)?.metadata);
  const metadataWithThumbnail =
    isVideoMessage && canonical.thumbnailUrl
      ? {
          ...(baseMetadata ?? {}),
          thumbnailUrl: (baseMetadata as any)?.thumbnailUrl ?? canonical.thumbnailUrl,
          thumbnail_url: (baseMetadata as any)?.thumbnail_url ?? canonical.thumbnailUrl,
          thumbnail: (baseMetadata as any)?.thumbnail ?? canonical.thumbnailUrl,
          posterUrl: (baseMetadata as any)?.posterUrl ?? canonical.thumbnailUrl,
          poster_url: (baseMetadata as any)?.poster_url ?? canonical.thumbnailUrl,
          poster: (baseMetadata as any)?.poster ?? canonical.thumbnailUrl,
          ...(canonical.thumbnailWidth
            ? {
                thumbnailWidth:
                  (baseMetadata as any)?.thumbnailWidth ?? canonical.thumbnailWidth,
                thumbnail_width:
                  (baseMetadata as any)?.thumbnail_width ?? canonical.thumbnailWidth,
              }
            : {}),
          ...(canonical.thumbnailHeight
            ? {
                thumbnailHeight:
                  (baseMetadata as any)?.thumbnailHeight ?? canonical.thumbnailHeight,
                thumbnail_height:
                  (baseMetadata as any)?.thumbnail_height ?? canonical.thumbnailHeight,
              }
            : {}),
          ...(canonical.thumbnailBlurhash
            ? {
                thumbnailBlurhash:
                  (baseMetadata as any)?.thumbnailBlurhash ??
                  canonical.thumbnailBlurhash,
                thumbnail_blurhash:
                  (baseMetadata as any)?.thumbnail_blurhash ??
                  canonical.thumbnailBlurhash,
                blurhash:
                  (baseMetadata as any)?.blurhash ?? canonical.thumbnailBlurhash,
              }
            : {}),
        }
      : baseMetadata;

  if (!opts?.includeLegacy) {
    return canonical;
  }

  return {
    ...message,
    ...canonical,
    chat_id: canonical.chatId,
    sender_id: canonical.senderId,
    message_type: canonical.messageType,
    media_url: canonical.mediaUrl,
    media_download_url: canonical.mediaDownloadUrl,
    thumbnail_url: canonical.thumbnailUrl,
    thumbnail_width: canonical.thumbnailWidth,
    thumbnail_height: canonical.thumbnailHeight,
    thumbnail_blurhash: canonical.thumbnailBlurhash,
    thumbnail_version: canonical.thumbnailVersion,
    thumbnail: canonical.thumbnailUrl,
    poster: canonical.thumbnailUrl,
    posterUrl: canonical.thumbnailUrl,
    poster_url: canonical.thumbnailUrl,
    videoThumbnailUrl: canonical.thumbnailUrl,
    video_thumbnail_url: canonical.thumbnailUrl,
    mediaThumbnailUrl: canonical.thumbnailUrl,
    media_thumbnail_url: canonical.thumbnailUrl,
    client_message_id: canonical.clientMessageId,
    media_mime: canonical.mediaMime,
    reply_to_message_id: canonical.replyToMessageId,
    sender_name: canonical.senderName,
    sender_username: canonical.senderUsername,
    sender_avatar_url: canonical.senderAvatarUrl,
    relativeTime: canonical.relativeTime,
    relative_time: canonical.relative_time,
    isEncrypted: canonical.isEncrypted,
    is_encrypted: canonical.is_encrypted,
    e2e: canonical.e2e,
    sender: senderFields.sender,
    metadata:
      metadataWithThumbnail ??
      (message as any)?.metadata ??
      null,
    contact: canonical.contact,
    share: canonical.share,
  };
};

export const serializeMessagesToCanonical = (
  values: any[],
  opts?: { includeLegacy?: boolean; locale?: AppLocale }
) =>
  Array.isArray(values)
    ? values.map((item) => serializeMessageToCanonical(item, opts))
    : [];
