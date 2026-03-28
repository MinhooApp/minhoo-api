import {
    Request,
    Response,
    formatResponse,
    repository,
    groupRepository,
} from '../_module/module';
import {
    emitChatStatusRealtime,
    emitChatsRefreshRealtime,
} from '../../../libs/helper/realtime_dispatch';
import { invalidateChatSummaryCacheByUser } from "../get/get";

const toPositiveInt = (value: any): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const safe = Math.trunc(parsed);
    if (safe <= 0) return null;
    return safe;
};

export const deleteChat = async (req: Request, res: Response) => {
    const { id } = req.params
    try {
        await repository.deleteChat(id, req.userId)
        invalidateChatSummaryCacheByUser(req.userId);
        return formatResponse({ res: res, success: true, body: true });
    } catch (error) {
        console.log(error);
        return formatResponse({ res: res, success: false, message: error });
    }
}

export const deleteMessage = async (req: Request, res: Response) => {
    try {
        const messageId = toPositiveInt((req.params as any)?.messageId);
        const actorUserId = toPositiveInt((req as any)?.userId);

        if (!messageId) {
            return formatResponse({
                res,
                success: false,
                code: 400,
                message: "messageId must be a valid number",
            });
        }

        if (!actorUserId) {
            return formatResponse({
                res,
                success: false,
                code: 401,
                message: "user not authenticated",
            });
        }

        const conversation = await repository.resolveConversationByMessageId(
            actorUserId,
            messageId
        );

        if (!conversation) {
            return formatResponse({
                res,
                success: false,
                code: 404,
                message: "message not found",
            });
        }

        const message = await repository.getMessageById(messageId);
        if (!message) {
            return formatResponse({
                res,
                success: false,
                code: 404,
                message: "message not found",
            });
        }

        const isOwner = Number((message as any)?.senderId) === actorUserId;
        let isGroupAdmin = false;
        if (conversation.conversationType === "group" && conversation.groupId) {
            isGroupAdmin = await groupRepository.isActorAdminInGroup(
                conversation.groupId,
                actorUserId
            );
        }

        if (!isOwner && !isGroupAdmin) {
            return formatResponse({
                res,
                success: false,
                code: 403,
                message: "only message owner or group admin can delete this message",
            });
        }

        await repository.markMessageDeletedForAll(messageId);

        const participantUserIds = await repository.getChatParticipantUserIds(
            conversation.chatId
        );
        const deletedAt = new Date().toISOString();
        const deletedByScope =
            isGroupAdmin && !isOwner ? "group_admin" : "owner";

        emitChatStatusRealtime(
            conversation.chatId,
            {
                chatId: conversation.chatId,
                chat_id: conversation.chatId,
                messageId,
                message_id: messageId,
                id: messageId,
                status: "deleted",
                deletedAt,
                deletedByUserId: actorUserId,
                deletedByScope,
                conversationType: conversation.conversationType,
                groupId: conversation.groupId,
                peerUserId: conversation.peerUserId,
            },
            participantUserIds
        );
        for (const uid of participantUserIds) {
            emitChatsRefreshRealtime(uid);
            invalidateChatSummaryCacheByUser(uid);
        }

        return formatResponse({
            res,
            success: true,
            body: {
                messageId,
                chatId: conversation.chatId,
                conversationType: conversation.conversationType,
                groupId: conversation.groupId,
                peerUserId: conversation.peerUserId,
                status: "deleted",
                deletedByScope,
                deletedAt,
            },
        });
    } catch (error) {
        console.log(error);
        return formatResponse({ res, success: false, message: error });
    }
};
