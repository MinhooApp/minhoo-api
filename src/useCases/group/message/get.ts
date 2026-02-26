import { Request, Response, formatResponse } from "../_module/module";
import * as repository from "../../../repository/group/group_chat_repository";
import * as groupRepository from "../../../repository/group/group_repository";
import { serializeGroup } from "../_shared/group_serializer";
import { serializeGroupMessages } from "./serializer";

const toPositiveInt = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const safe = Math.trunc(parsed);
  if (safe <= 0) return null;
  return safe;
};

const normalizeLimit = (value: any): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(Math.trunc(parsed), 200));
};

export const group_messages = async (req: Request, res: Response) => {
  try {
    const groupId = toPositiveInt((req.params as any)?.groupId);
    if (!groupId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "groupId must be a valid number",
      });
    }

    const viewerUserId = toPositiveInt((req as any)?.userId);
    const limit = normalizeLimit((req.query as any)?.limit);
    const beforeMessageId = toPositiveInt((req.query as any)?.beforeMessageId);

    const response = await repository.getGroupMessagesPage({
      groupId,
      viewerUserId,
      limit,
      beforeMessageId,
    });

    if (!response.ok) {
      if (response.reason === "group_not_found") {
        return formatResponse({
          res,
          success: false,
          code: 404,
          message: "group not found",
        });
      }
      if (response.reason === "forbidden_view") {
        return formatResponse({
          res,
          success: false,
          code: 403,
          message: "you cannot view this group chat",
        });
      }
      return formatResponse({
        res,
        success: false,
        code: 409,
        message: "could not load group messages",
      });
    }

    if (
      viewerUserId &&
      response.policy.is_member &&
      !beforeMessageId &&
      Array.isArray(response.messages) &&
      response.messages.length > 0
    ) {
      const lastVisibleMessageId = (response.messages as any[])
        .map((item) => Number((item as any)?.id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .reduce((max, id) => (id > max ? id : max), 0);
      if (lastVisibleMessageId > 0) {
        await groupRepository.updateChatLastReadMessageId(
          Number(response.chatId),
          Number(viewerUserId),
          lastVisibleMessageId
        );
      }
    }

    const [activeMembers, unreadCount] = await Promise.all([
      groupRepository.countActiveMembers(groupId),
      viewerUserId && response.policy.is_member
        ? groupRepository.countUnreadMessagesByChat(
            Number(response.chatId),
            Number(viewerUserId)
          )
        : Promise.resolve(0),
    ]);

    const normalizedChatId = Number(response.chatId) || 0;
    const serializedMessages = serializeGroupMessages(response.messages as any[]);

    return formatResponse({
      res,
      success: true,
      body: {
        chatId: normalizedChatId,
        messages: serializedMessages,

        // legacy response fields
        group_id: groupId,
        chat_id: normalizedChatId,
        group: serializeGroup(response.group, {
          activeMembers: Number(activeMembers) || 0,
          unreadCount: Number(unreadCount) || 0,
        }),
        access: response.policy,
        unread_count: Number(unreadCount) || 0,
        paging: {
          limit,
          beforeMessageId: beforeMessageId ?? null,
          next_cursor: response.nextCursor,
        },
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error as any });
  }
};
