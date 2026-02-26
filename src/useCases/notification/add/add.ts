import { TypeNotification } from "_models/notification/type_notification";
import {
  repository,
  sendPushToSingleUser,
  userRepository,
} from "../_module/module";
import { emitNotificationRealtime } from "../../../libs/helper/realtime_dispatch";
import * as chatRepository from "../../../repository/chat/chat_repository";
import * as groupRepository from "../../../repository/group/group_repository";

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

  senderName?: string;

  notificationScope?: NotificationScope;
  chatId?: number;
  peerUserId?: number;
  groupId?: number;
  groupName?: string;
  groupAvatarUrl?: string;
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

export const sendNotification = async (
  params: SendNotificationParams
): Promise<void> => {
  try {
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

    const pushBody = params.message;

    const extraData: Record<string, string | number> = {
      senderName: params.senderName ?? "",
      senderId: params.interactorId ?? "",
    };

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

    const pushTitle =
      params.type === "message"
        ? pushParams.notificationScope === "group"
          ? String(pushParams.groupName ?? "").trim() ||
            params.senderName?.trim() ||
            "Nuevo mensaje"
          : params.senderName?.trim() || "Nuevo mensaje"
        : "Minhoo news";

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
