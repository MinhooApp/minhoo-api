import { TypeNotification } from "_models/notification/type_notification";
import {
  repository,
  sendPushToMultipleUsers,
  userRepository,
} from "../_module/module";
import { emitNotificationRealtime } from "../../../libs/helper/realtime_dispatch";
import * as chatRepository from "../../../repository/chat/chat_repository";
import * as groupRepository from "../../../repository/group/group_repository";
import { bumpHomeNotificationsCacheVersion } from "../../../libs/cache/bootstrap_home_cache_version";

type NotificationScope = "direct" | "group";

interface SendNotificationParams {
  userId: number;
  interactorId?: number;
  serviceId?: number;
  postId?: number;
  reelId?: number;
  offerId?: number;
  followerId?: number;
  notification_date?: Date;
  type: TypeNotification;
  message: string;

  likerId?: number;
  commentId?: number;
  messageId?: number;

  senderName?: string;

  notificationScope?: NotificationScope;
  chatId?: number;
  peerUserId?: number;
  groupId?: number;
  groupName?: string;
  groupAvatarUrl?: string;
  deeplink?: string;
  preferredLanguage?: string;
}

const PUSH_EMPTY_TOKEN_LOG_WINDOW_MS = Math.max(
  10_000,
  Number(process.env.PUSH_EMPTY_TOKEN_LOG_WINDOW_MS ?? 10 * 60 * 1000) || 10 * 60 * 1000
);
const MIN_PUSH_TOKEN_LENGTH = Math.max(
  20,
  Number(process.env.PUSH_MIN_TOKEN_LENGTH ?? 100) || 100
);
const PUSH_LOCALE_DEBUG = String(process.env.PUSH_LOCALE_DEBUG ?? "0").trim() === "1";
const pushEmptyTokenLogMemory = new Map<string, number>();

const toPositiveInt = (value: any): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return undefined;
  return safe;
};

const shouldLogMissingToken = (userId: number, type: TypeNotification) => {
  const key = `${Number(userId)}:${String(type)}`;
  const now = Date.now();
  const last = Number(pushEmptyTokenLogMemory.get(key) ?? 0);
  if (now - last < PUSH_EMPTY_TOKEN_LOG_WINDOW_MS) {
    return false;
  }
  pushEmptyTokenLogMemory.set(key, now);
  return true;
};

const buildChatDeeplink = (params: {
  scope: NotificationScope;
  peerUserId?: number;
  groupId?: number;
  messageId?: number;
}) => {
  const messageSuffix = params.messageId ? `?messageId=${params.messageId}` : "";

  if (params.scope === "group" && params.groupId) {
    return `chat/group/${params.groupId}${messageSuffix}`;
  }

  if (params.scope === "direct" && params.peerUserId) {
    return `chat/direct/${params.peerUserId}${messageSuffix}`;
  }

  return "";
};

const buildChatPushData = (
  params: SendNotificationParams
): Record<string, string | number> => {
  if (params.type !== "message") return {};

  const chatId = toPositiveInt(params.chatId);
  const messageId = toPositiveInt(params.messageId);
  const groupId = toPositiveInt(params.groupId);
  const peerUserId =
    toPositiveInt(params.peerUserId) ?? toPositiveInt(params.interactorId);

  const resolvedScope: NotificationScope =
    params.notificationScope === "group" || (!params.notificationScope && groupId)
      ? "group"
      : "direct";

  if (!chatId) {
    throw new Error("chatId is required for chat push payload");
  }
  if (!messageId) {
    throw new Error("messageId is required for chat push payload");
  }

  if (resolvedScope === "group") {
    if (!groupId) {
      throw new Error("groupId is required when notificationScope is group");
    }

    const resolvedGroupName =
      String(params.groupName ?? "").trim() || `Group ${groupId}`;
    const resolvedGroupAvatarUrl = String(params.groupAvatarUrl ?? "").trim();

    const deeplink =
      String(params.deeplink ?? "").trim() ||
      buildChatDeeplink({ scope: "group", groupId, messageId });

    return {
      route: "chat",
      notificationScope: "group",
      conversationType: "group",
      chatId,
      messageId,
      groupId,
      groupName: resolvedGroupName,
      groupAvatarUrl: resolvedGroupAvatarUrl,

      // legacy compatibility (1 release)
      chat_id: chatId,
      message_id: messageId,
      group_id: groupId,
      conversation_type: "group",
      group_name: resolvedGroupName,
      group_avatar_url: resolvedGroupAvatarUrl,

      ...(deeplink ? { deeplink } : {}),
    };
  }

  if (!peerUserId) {
    throw new Error("peerUserId is required when notificationScope is direct");
  }

  const deeplink =
    String(params.deeplink ?? "").trim() ||
    buildChatDeeplink({ scope: "direct", peerUserId, messageId });

  return {
    route: "chat",
    notificationScope: "direct",
    conversationType: "direct",
    chatId,
    messageId,
    peerUserId,

    // legacy compatibility (1 release)
    chat_id: chatId,
    message_id: messageId,
    peer_user_id: peerUserId,
    conversation_type: "direct",

    ...(deeplink ? { deeplink } : {}),
  };
};

const hasChatRoutingData = (params: SendNotificationParams) => {
  if (params.notificationScope === "direct" || params.notificationScope === "group") {
    return true;
  }
  if (toPositiveInt(params.chatId)) return true;
  if (toPositiveInt(params.peerUserId)) return true;
  if (toPositiveInt(params.groupId)) return true;
  return false;
};

type PushLocale = "en" | "es";

const normalizePushLocale = (raw: any): PushLocale | null => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return null;

  if (
    normalized.startsWith("es") ||
    normalized.includes("spanish") ||
    normalized.includes("espanol") ||
    normalized.includes("español")
  ) {
    return "es";
  }

  if (
    normalized.startsWith("en") ||
    normalized.includes("english") ||
    normalized.includes("ingles") ||
    normalized.includes("inglés")
  ) {
    return "en";
  }

  return null;
};

const firstDetectedLocale = (values: any[]): PushLocale | null => {
  for (const value of values) {
    const detected = normalizePushLocale(value);
    if (detected) return detected;
  }
  return null;
};

const resolvePushLocale = (params: {
  preferredLanguage?: string;
  language?: string | null;
  languageCodes?: any;
  languageNames?: any;
}): PushLocale => {
  const fromPreferred = normalizePushLocale(params.preferredLanguage);
  if (fromPreferred) return fromPreferred;

  const fromLanguage = normalizePushLocale(params.language);
  if (fromLanguage) return fromLanguage;

  const languageCodes = Array.isArray(params.languageCodes) ? params.languageCodes : [];
  const fromCodes = firstDetectedLocale(languageCodes);
  if (fromCodes) return fromCodes;

  const languageNames = Array.isArray(params.languageNames) ? params.languageNames : [];
  const fromNames = firstDetectedLocale(languageNames);
  if (fromNames) return fromNames;

  return "en";
};

const toSpanishPushTitle = (title: string) => {
  if (title === "Minhoo news") return "Novedades de Minhoo";
  if (title === "New message") return "Nuevo mensaje";
  if (title === "New Service Posted") return "Nuevo servicio publicado";

  const groupMatch = title.match(/^Group\s+(\d+)$/i);
  if (groupMatch) return `Grupo ${groupMatch[1]}`;

  return title;
};

const toSpanishPushBody = (body: string) => {
  const directMap: Record<string, string> = {
    "Has saved your post.": "Ha guardado tu publicacion.",
    "Sent you a new offer!": "Te envio una nueva oferta.",
    "has accepted your job offer!": "ha aceptado tu oferta de trabajo.",
    "Application canceled": "Solicitud cancelada",
    "has withdrawn your candidacy": "ha retirado tu candidatura.",
    "The offer has closed.": "La oferta se cerro.",
    "Has starred your Orbit.": "Ha destacado tu Orbit.",
    "Has saved your Orbit.": "Ha guardado tu Orbit.",
    "Has commented on your Orbit.": "Ha comentado en tu Orbit.",
    "You have a new comment": "Tienes un comentario nuevo.",
    "Has given your post a star!": "Le ha dado una estrella a tu publicacion.",
    "You have a new message": "Tienes un mensaje nuevo.",
    "You were removed from a group": "Te removieron de un grupo.",
    "New group join request pending approval":
      "Nueva solicitud para unirse al grupo pendiente de aprobacion.",
    "Your group join request was approved":
      "Tu solicitud para unirte al grupo fue aprobada.",
    "Your group join request was rejected":
      "Tu solicitud para unirte al grupo fue rechazada.",
  };

  if (Object.prototype.hasOwnProperty.call(directMap, body)) {
    return directMap[body];
  }

  const followMatch = body.match(/^(.+?)\s+started following you$/i);
  if (followMatch) {
    return `${followMatch[1]} comenzo a seguirte`;
  }

  const recommendationPrefix = "Suggested profile:";
  if (body.startsWith(recommendationPrefix)) {
    return `Perfil sugerido:${body.slice(recommendationPrefix.length)}`;
  }

  const reactedPreviewMatch = body.match(/^Reacted\s+(.+?)\s+to:\s+(.+)$/i);
  if (reactedPreviewMatch) {
    return `Reacciono ${reactedPreviewMatch[1]} a: ${reactedPreviewMatch[2]}`;
  }

  const reactedMessageMatch = body.match(/^Reacted\s+(.+?)\s+to your message$/i);
  if (reactedMessageMatch) {
    return `Reacciono ${reactedMessageMatch[1]} a tu mensaje`;
  }

  const groupMessageMatch = body.match(/^(.+?):\s+New message$/i);
  if (groupMessageMatch) {
    return `${groupMessageMatch[1]}: Nuevo mensaje`;
  }

  if (body === "New message") return "Nuevo mensaje";

  return body;
};

const localizePushTitle = (title: string, locale: PushLocale) => {
  if (locale !== "es") return title;
  return toSpanishPushTitle(title);
};

const localizePushBody = (body: string, locale: PushLocale) => {
  if (locale !== "es") return body;
  return toSpanishPushBody(body);
};

export const sendNotification = async (
  params: SendNotificationParams
): Promise<void> => {
  try {
    if (params.userId === params.interactorId) {
      // return;
    }

    const now = new Date(new Date().toUTCString());
    const pushSettings = await userRepository.getPushSettings(params.userId);
    const uuid = String(pushSettings?.uuid ?? "").trim();
    const uuids = Array.from(
      new Set(
        [uuid, ...(pushSettings?.uuids ?? [])]
          .map((token) => String(token ?? "").trim())
          .filter((token) => token.length >= MIN_PUSH_TOKEN_LENGTH)
      )
    );
    const pushLocale = resolvePushLocale({
      preferredLanguage: params.preferredLanguage,
      language: pushSettings?.language,
      languageCodes: pushSettings?.language_codes,
      languageNames: pushSettings?.language_names,
    });
    const localizedMessage = localizePushBody(String(params.message ?? ""), pushLocale);

    const notificationData = {
      userId: params.userId,
      interactorId: params.interactorId,
      serviceId: params.serviceId,
      postId: params.postId,
      reelId: params.reelId,
      offerId: params.offerId,
      type: params.type,
      message: localizedMessage,
      likerId: params.likerId,
      commentId: params.commentId,
      messageId: params.messageId,
      notification_date: now,
      read: false,
    };

    const notification = await repository.add(notificationData);
    await bumpHomeNotificationsCacheVersion(params.userId);

    emitNotificationRealtime(params.userId, notification);

    const pushBody = localizedMessage;

    const extraData: Record<string, string | number> = {
      senderName: params.senderName ?? "",
      senderId: params.interactorId ?? "",
    };
    const normalizedDeeplink = String(params.deeplink ?? "").trim();
    if (normalizedDeeplink) {
      extraData.deeplink = normalizedDeeplink;
    }

    const notificationPostId = toPositiveInt(params.postId);
    if (notificationPostId) {
      extraData.postId = notificationPostId;
      extraData.post_id = notificationPostId;
    }

    const notificationReelId = toPositiveInt(params.reelId);
    if (notificationReelId) {
      extraData.reelId = notificationReelId;
      extraData.reel_id = notificationReelId;
      extraData.route = "orbit";
      extraData.entityType = "reel";
      extraData.entity_type = "reel";
      extraData.deeplink = normalizedDeeplink || `orbit/${notificationReelId}`;
    }

    const notificationCommentId = toPositiveInt(params.commentId);
    if (notificationCommentId) {
      extraData.commentId = notificationCommentId;
      extraData.comment_id = notificationCommentId;
    }

    const notificationMessageId = toPositiveInt(params.messageId);
    if (notificationMessageId) {
      extraData.messageId = notificationMessageId;
    }

    let pushParams: SendNotificationParams = params;

    if (params.type === "message" && !hasChatRoutingData(params) && notificationMessageId) {
      const resolvedConversation = await chatRepository.resolveConversationByMessageId(
        params.userId,
        notificationMessageId
      );

      if (resolvedConversation) {
        pushParams = {
          ...params,
          notificationScope: resolvedConversation.conversationType,
          chatId: resolvedConversation.chatId,
          messageId: resolvedConversation.messageId,
          peerUserId: resolvedConversation.peerUserId ?? params.peerUserId,
          groupId: resolvedConversation.groupId ?? params.groupId,
        };
      }
    }

    if (pushParams.type === "message" && pushParams.notificationScope === "group") {
      const resolvedGroupId = toPositiveInt(pushParams.groupId);
      let groupName = String(pushParams.groupName ?? "").trim();
      let groupAvatarUrl = String(pushParams.groupAvatarUrl ?? "").trim();

      if (resolvedGroupId && (!groupName || !groupAvatarUrl)) {
        const group = await groupRepository.getActiveGroupById(resolvedGroupId);
        if (group) {
          if (!groupName) {
            groupName = String((group as any)?.name ?? "").trim();
          }
          if (!groupAvatarUrl) {
            groupAvatarUrl = String((group as any)?.avatarUrl ?? "").trim();
          }
        }
      }

      if (resolvedGroupId) {
        pushParams = {
          ...pushParams,
          groupId: resolvedGroupId,
          groupName: groupName || `Group ${resolvedGroupId}`,
          groupAvatarUrl: groupAvatarUrl || "",
        };
      }
    }

    if (pushParams.type === "message" && hasChatRoutingData(pushParams)) {
      Object.assign(extraData, buildChatPushData(pushParams));
    }

    const pushTitleRaw =
      params.type === "message"
        ? pushParams.notificationScope === "group"
          ? String(pushParams.groupName ?? "").trim() ||
            params.senderName?.trim() ||
            "Nuevo mensaje"
          : params.senderName?.trim() || "Nuevo mensaje"
        : "Minhoo news";
    const pushTitle = localizePushTitle(pushTitleRaw, pushLocale);

    if (PUSH_LOCALE_DEBUG) {
      console.log(
        `[push][locale] userId=${params.userId} type=${params.type} locale=${pushLocale} rawTitle=${JSON.stringify(
          pushTitleRaw
        )} localizedTitle=${JSON.stringify(pushTitle)} rawBody=${JSON.stringify(
          String(params.message ?? "")
        )} localizedBody=${JSON.stringify(pushBody)}`
      );
    }

    if (!uuids.length) {
      if (shouldLogMissingToken(params.userId, params.type)) {
        console.log(
          `[push] skipped missing token userId=${params.userId} type=${params.type} interactorId=${params.interactorId ?? 0}`
        );
      }
      return;
    }

    const pushResult = await sendPushToMultipleUsers(
      pushTitle,
      pushBody,
      params.type,
      getFirstAvailableId(notificationData),
      uuids,
      extraData
    );

    if ((pushResult as any)?.reason === "EMPTY_TOKEN" || (pushResult as any)?.reason === "EMPTY_TOKENS") {
      if (shouldLogMissingToken(params.userId, params.type)) {
        console.log(
          `[push] empty token userId=${params.userId} type=${params.type} interactorId=${params.interactorId ?? 0}`
        );
      }
    }

    const invalidTokens = Array.isArray((pushResult as any)?.invalidTokens)
      ? (pushResult as any).invalidTokens
      : [];
    for (const invalidTokenRaw of invalidTokens) {
      const invalidToken = String(invalidTokenRaw ?? "").trim();
      if (!invalidToken) continue;

      const clearedLegacy = await userRepository.clearUuidIfMatch(params.userId, invalidToken);
      await userRepository.clearPushSessionTokenIfMatch(params.userId, invalidToken);

      if (clearedLegacy > 0) {
        console.log(`🧹 UUID inválido limpiado userId=${params.userId} reason=MULTICAST_INVALID_TOKEN`);
      } else {
        console.log(
          `🧹 UUID inválido detectado sin limpieza userId=${params.userId} reason=MULTICAST_INVALID_TOKEN`
        );
      }
    }
  } catch (error) {
    console.error("Error al enviar la notificación:", error);
    throw error;
  }
};

function getFirstAvailableId(data: SendNotificationParams): number {
  switch (data.type) {
    case "postulation":
    case "applicationCanceled":
    case "offerAccepted":
    case "applicationRemoved":
    case "requestCanceled":
      return data.serviceId!;

    case "like":
    case "comment":
      return (
        data.postId ||
        data.reelId ||
        data.commentId ||
        data.likerId ||
        data.interactorId!
      )!;

    case "follow":
    case "message":
      return data.interactorId!;
    case "profile_recommendation":
      return data.followerId || data.interactorId!;

    case "admin":
    default:
      return (
        data.serviceId ||
        data.postId ||
        data.offerId ||
        data.likerId ||
        data.commentId ||
        data.followerId ||
        data.messageId!
      )!;
  }
}
