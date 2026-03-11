import {
    Request,
    Response,
    formatResponse,
    repository,
    postRepository,
    groupRepository,
    socket,
} from '../_module/module';
import * as notificationRepository from '../../../repository/notification/notification_repository';
import { emitNotificationDeletedRealtime } from '../../../libs/helper/realtime_dispatch';

const toPositiveInt = (value: any): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const safe = Math.trunc(parsed);
    if (safe <= 0) return null;
    return safe;
};

const toPlainObject = (value: any): any => {
    if (!value) return value;
    if (typeof value.toJSON === "function") return value.toJSON();
    if (value.dataValues && typeof value.dataValues === "object") {
        return { ...value.dataValues };
    }
    return value;
};

const buildDeletedNotificationPayload = (notification: any, deletedAt: string) => {
    const source = toPlainObject(notification) ?? {};
    const notificationId = Number(source.id ?? 0) || null;
    return {
        ...source,
        id: notificationId,
        notificationId,
        notification_id: notificationId,
        action: 'deleted',
        removed: true,
        deleted: true,
        deletedAt,
        deleted_at: deletedAt,
    };
};

export const deleteComment = async (req: Request, res: Response) => {
    const commentId = toPositiveInt((req.params as any)?.id);
    const actorUserId = toPositiveInt((req as any)?.userId);
    try {
        if (!commentId) {
            return formatResponse({
                res,
                success: false,
                code: 400,
                message: "comment id is invalid",
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

        const comment = await repository.get(commentId);
        if (!comment) {
            return formatResponse({
                res,
                success: false,
                code: 404,
                message: "comment not found",
            });
        }

        const isCommentOwner = Number((comment as any)?.userId) === actorUserId;

        const groupId =
            toPositiveInt((req.params as any)?.groupId) ??
            toPositiveInt((req.query as any)?.groupId) ??
            toPositiveInt((req.body as any)?.groupId);

        let isGroupAdmin = false;
        if (!isCommentOwner && groupId) {
            isGroupAdmin = await groupRepository.isActorAdminInGroup(groupId, actorUserId);
        }

        if (!isCommentOwner && !isGroupAdmin) {
            return formatResponse({
                res,
                success: false,
                code: 403,
                message: "only comment owner or group admin can delete this comment",
            });
        }

        await repository.deletecomment(commentId);
        const postId = Number((comment as any).postId ?? 0);
        const post = await postRepository.get(postId, actorUserId);
        const postPayload = toPlainObject(post) ?? {};
        const deletedAt = new Date().toISOString();

        socket.emit("post/comment-deleted", {
            action: "comment_deleted",
            removed: true,
            postId,
            post_id: postId,
            commentId,
            comment_id: commentId,
            ownerId: Number(postPayload?.userId ?? 0),
            owner_id: Number(postPayload?.userId ?? 0),
            actorUserId,
            actor_user_id: actorUserId,
            commentsCount: Number(postPayload?.comments_count ?? 0),
            comments_count: Number(postPayload?.comments_count ?? 0),
            deletedAt,
            deleted_at: deletedAt,
        });

        const notifications = await notificationRepository.findActiveCommentNotifications({
            commentId,
            postId,
        });
        if (notifications.length > 0) {
            await notificationRepository.softDeleteByIds(
                notifications.map((notification: any) => Number((notification as any)?.id ?? 0))
            );
            notifications.forEach((notification: any) => {
                const notificationPayload = buildDeletedNotificationPayload(notification, deletedAt);
                const notificationUserId = Number(notificationPayload?.userId ?? 0);
                if (notificationUserId > 0) {
                    emitNotificationDeletedRealtime(notificationUserId, notificationPayload);
                }
            });
        }

        return formatResponse({ res, success: true, body: { post } });
    } catch (error) {
        return formatResponse({ res, success: false, message: error });
    }
}
