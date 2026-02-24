import { TypeNotification } from "_models/notification/type_notification";
import {
  repository,
  sendPushToSingleUser,
  userRepository,
} from "../_module/module";
import { emitNotificationRealtime } from "../../../libs/helper/realtime_dispatch";

type NotificationScope = "direct" | "group";

interface SendNotificationParams {
  userId: number;
  interactorId?: number;
  serviceId?: number;
  postId?: number;
  offerId?: number;
  followerId?: number;
  notification_date?: Date;
  type: TypeNotification;
  message: string;

  likerId?: number;
  commentId?: number;
  messageId?: number;

  // ✅ NUEVO: nombre del que dispara la notificación (chat)
  senderName?: string;

  // Chat routing payload (push)
  notificationScope?: NotificationScope;
  peerUserId?: number;
  groupId?: number;
  deeplink?: string;
}

const toPositiveInt = (value: any): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return undefined;
  return safe;
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

const buildChatPushData = (params: SendNotificationParams): Record<string, string | number> => {
  if (params.type !== "message") return {};

  const messageId = toPositiveInt(params.messageId);
  const groupId = toPositiveInt(params.groupId);
  const peerUserId = toPositiveInt(params.peerUserId) ?? toPositiveInt(params.interactorId);

  const resolvedScope: NotificationScope =
    params.notificationScope === "group" || (!params.notificationScope && groupId)
      ? "group"
      : "direct";

  if (resolvedScope === "group") {
    if (!groupId) {
      throw new Error("groupId is required when notificationScope is group");
    }

    const deeplink =
      String(params.deeplink ?? "").trim() ||
      buildChatDeeplink({ scope: "group", groupId, messageId });

    return {
      route: "chat",
      notificationScope: "group",
      groupId,
      ...(messageId ? { messageId } : {}),
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
    peerUserId,
    ...(messageId ? { messageId } : {}),
    ...(deeplink ? { deeplink } : {}),
  };
};

const hasChatRoutingData = (params: SendNotificationParams) => {
  if (params.notificationScope === "direct" || params.notificationScope === "group") {
    return true;
  }
  if (toPositiveInt(params.peerUserId)) return true;
  if (toPositiveInt(params.groupId)) return true;
  return false;
};

export const sendNotification = async (
  params: SendNotificationParams
): Promise<void> => {
  try {
    // si es el mismo usuario, puedes evitar notificar (si quieres)
    if (params.userId === params.interactorId) {
      // return;
    }

    const now = new Date(new Date().toUTCString());

    const notificationData = {
      userId: params.userId,
      interactorId: params.interactorId,
      serviceId: params.serviceId,
      postId: params.postId,
      offerId: params.offerId,
      type: params.type,
      message: params.message,
      likerId: params.likerId,
      commentId: params.commentId,
      messageId: params.messageId,
      notification_date: now,
      read: false,
    };

    const notification = await repository.add(notificationData);
    const uuid = await userRepository.getUuid(params.userId);

    emitNotificationRealtime(params.userId, notification);

    // ✅ Para chat: queremos que se vea el nombre en la barra de notificaciones
    const pushTitle =
      params.type === "message"
        ? (params.senderName?.trim() || "Nuevo mensaje")
        : "Minhoo news";

    const pushBody = params.message;

    // ✅ data extra para Flutter (foreground)
    const extraData: Record<string, string | number> = {
      senderName: params.senderName ?? "",     // Flutter lo usa como title
      senderId: params.interactorId ?? "",     // para filtrar/suprimir
    };

    const notificationMessageId = toPositiveInt(params.messageId);
    if (notificationMessageId) {
      extraData.messageId = notificationMessageId;
    }

    if (params.type === "message" && hasChatRoutingData(params)) {
      Object.assign(extraData, buildChatPushData(params));
    }

    const pushResult = await sendPushToSingleUser(
      pushTitle,
      pushBody,
      uuid,
      params.type,
      getFirstAvailableId(notificationData),
      extraData
    );

    if (pushResult?.reason === "EMPTY_TOKEN") {
      console.warn(
        `[push] empty token userId=${params.userId} type=${params.type} interactorId=${params.interactorId ?? 0}`
      );
    }

    if (pushResult?.reason === "TOKEN_NOT_REGISTERED" && uuid) {
      const cleared = await userRepository.clearUuidIfMatch(params.userId, uuid);
      if (cleared > 0) {
        console.warn(
          `🧹 UUID inválido limpiado userId=${params.userId} reason=TOKEN_NOT_REGISTERED`
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
      return data.postId!;

    case "follow":
    case "message":
      return data.interactorId!;

    case "admin":
    default:
      return (data.serviceId ||
        data.postId ||
        data.offerId ||
        data.likerId ||
        data.commentId ||
        data.followerId ||
        data.messageId!)!;
  }
}
