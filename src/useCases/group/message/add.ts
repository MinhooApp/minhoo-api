import { Request, Response, formatResponse, sendNotification } from "../_module/module";
import {
  buildMessagePayload,
  hydrateContactMetadata,
  normalizeClientMessageId,
  toInt,
} from "../../chat/add/add";
import * as repository from "../../../repository/group/group_chat_repository";
import {
  emitChatMessageRealtime,
  emitChatsRefreshRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { serializeGroupMessage } from "./serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

export const send_group_message = async (req: Request, res: Response) => {
  try {
    const senderUserId = toPositiveInt((req as any).userId);
    if (!senderUserId) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "user not authenticated",
      });
    }

    const groupId = toPositiveInt((req.params as any)?.groupId);
    if (!groupId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId must be a valid number",
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
      (messagePayload as any).clientMessageId = clientMessageId;
    }

    if (messagePayload.messageType === "contact") {
      const hydratedContact = await hydrateContactMetadata(
        (messagePayload.metadata as any) ?? null
      );
      if (!hydratedContact) {
        return formatResponse({
          res,
          success: false,
          code: 400,
          message: "contact is invalid. Send a valid contact.user_id",
        });
      }
      messagePayload.metadata = hydratedContact as any;
    }

    const replyToMessageId =
      toInt((req.body as any)?.replyToMessageId) ??
      toInt((req.body as any)?.reply_to_message_id);

    const created = await repository.createGroupMessage({
      groupId,
      senderUserId,
      payload: messagePayload as any,
      replyToMessageId,
    });

    if (!created.ok) {
      if (created.reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }
      if (created.reason === "forbidden_interact") {
        return formatResponse({
          res,
          success: false,
          code: 403,
          message: "you cannot send messages in this group",
        });
      }
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not send group message",
      });
    }

    const fullMessage = created.message;
    if (!fullMessage) {
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not load created message",
      });
    }

    const serializedMessage = serializeGroupMessage(fullMessage);
    const wasDeduplicated = Boolean((created as any).deduplicated);

    if (!wasDeduplicated) {
      emitChatMessageRealtime(
        Number(created.chatId),
        serializedMessage,
        created.memberUserIds,
        [senderUserId]
      );
      for (const userId of created.memberUserIds) {
        emitChatsRefreshRealtime(userId);
      }
    }

    const groupNameRaw = String((created as any)?.group?.name ?? "").trim();
    const groupAvatarUrlRaw = String((created as any)?.group?.avatarUrl ?? "").trim();
    const groupLabel = groupNameRaw || `Group ${groupId}`;
    const previewRaw = String(payloadResult.notificationPreview ?? "").trim();
    const preview = previewRaw.length > 60 ? `${previewRaw.slice(0, 60)}...` : previewRaw;
    const notificationBody = preview
      ? `${groupLabel}: ${preview}`
      : `${groupLabel}: New message`;
    const senderName =
      String((serializedMessage as any)?.senderName ?? "").trim() ||
      String((serializedMessage as any)?.sender_name ?? "").trim() ||
      "New message";
    const normalizedChatId = Number(created.chatId);
    const createdMessageId = Number((serializedMessage as any)?.id ?? 0) || undefined;

    const targets = (created.memberUserIds as number[]).filter((uid) => uid !== senderUserId);
    if (!wasDeduplicated && targets.length > 0) {
      // Push/notification must never block nor fail the group message response.
      void Promise.all(
        targets.map((targetUserId) =>
          sendNotification({
            userId: targetUserId,
            interactorId: senderUserId,
            chatId: normalizedChatId,
            messageId: createdMessageId,
            type: "message",
            message: notificationBody,
            senderName,
            notificationScope: "group",
            groupId,
            groupName: groupLabel,
            groupAvatarUrl: groupAvatarUrlRaw || "",
          })
        )
      ).catch((pushError) => {
        console.warn(
          `[group][sendMessage] notification dispatch failed groupId=${groupId} chatId=${normalizedChatId} messageId=${createdMessageId}`,
          pushError
        );
      });
    }

    return formatResponse({
      res,
      success: true,
      body: {
        chatId: normalizedChatId,
        group_id: groupId,
        chat_id: normalizedChatId,
        message: serializedMessage,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error as any });
  }
};
