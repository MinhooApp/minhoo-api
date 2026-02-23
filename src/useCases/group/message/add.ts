import { Request, Response, formatResponse, sendNotification } from "../_module/module";
import {
  buildMessagePayload,
  hydrateContactMetadata,
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

    const payloadResult = buildMessagePayload(req.body);
    if (!payloadResult.ok) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: payloadResult.error,
      });
    }

    const messagePayload = payloadResult.payload;
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

    emitChatMessageRealtime(
      Number(created.chatId),
      serializedMessage,
      created.memberUserIds,
      [senderUserId]
    );
    for (const userId of created.memberUserIds) {
      emitChatsRefreshRealtime(userId);
    }

    const groupNameRaw = String((created as any)?.group?.name ?? "").trim();
    const groupLabel = groupNameRaw || `Group ${groupId}`;
    const previewRaw = String(payloadResult.notificationPreview ?? "").trim();
    const preview = previewRaw.length > 60 ? `${previewRaw.slice(0, 60)}...` : previewRaw;
    const notificationBody = preview
      ? `${groupLabel}: ${preview}`
      : `${groupLabel}: New message`;
    const senderName = String((serializedMessage as any)?.sender_name ?? "").trim() || "New message";
    const normalizedChatId = Number(created.chatId);

    const targets = (created.memberUserIds as number[]).filter((uid) => uid !== senderUserId);
    if (targets.length > 0) {
      try {
        await Promise.all(
          targets.map((targetUserId) =>
            sendNotification({
              userId: targetUserId,
              interactorId: senderUserId,
              messageId: Number((serializedMessage as any)?.id ?? 0) || undefined,
              type: "message",
              message: notificationBody,
              senderName,
            })
          )
        );
      } catch (_error) {
        // Do not fail group message delivery if push notification dispatch fails.
      }
    }

    return formatResponse({
      res,
      success: true,
      body: {
        group_id: groupId,
        chat_id: normalizedChatId,
        message: serializedMessage,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error as any });
  }
};
