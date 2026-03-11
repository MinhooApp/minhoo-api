import { Request, Response, formatResponse, repository, socket } from "../_module/module";
import * as notificationRepository from "../../../repository/notification/notification_repository";
import { emitNotificationDeletedRealtime } from "../../../libs/helper/realtime_dispatch";

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
    action: "deleted",
    removed: true,
    deleted: true,
    deletedAt,
    deleted_at: deletedAt,
  };
};

export const delete_reel = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await repository.deleteReel(id, req.userId);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "reel not found",
      });
    }

    if (result.forbidden) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you do not have permission to delete this reel",
      });
    }

    const reelId = Number(id);
    const ownerId = Number((result as any)?.reel?.userId ?? req.userId ?? 0);
    const deletedAt = new Date().toISOString();
    const payload = {
      action: "deleted",
      reelId,
      reel_id: reelId,
      ownerId,
      owner_id: ownerId,
      deletedAt,
      deleted_at: deletedAt,
      reel: (result as any)?.reel ?? null,
    };

    socket.emit("reel/deleted", payload);

    return formatResponse({
      res,
      success: true,
      body: {
        deleted: true,
        reelId,
        reel_id: reelId,
        reel: result.reel,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};

export const delete_reel_comment = async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const result = await repository.deleteComment(commentId, req.userId);

    if (result.notFound) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "comment not found",
      });
    }

    if (result.forbidden) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you do not have permission to delete this comment",
      });
    }

    const reelId = Number((result as any)?.reelId ?? 0);
    const deletedAt = new Date().toISOString();
    const payload = {
      action: "comment_deleted",
      removed: Boolean((result as any)?.removed),
      reelId,
      reel_id: reelId,
      commentId: Number(commentId),
      comment_id: Number(commentId),
      comments_count: Number((result as any)?.comments_count ?? 0),
      commentsCount: Number((result as any)?.comments_count ?? 0),
      deletedAt,
      deleted_at: deletedAt,
    };

    socket.emit("reel/comment-deleted", payload);

    const notifications = await notificationRepository.findActiveCommentNotifications({
      commentId: Number(commentId),
      reelId,
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

    return formatResponse({
      res,
      success: true,
      body: {
        removed: result.removed,
        reelId: result.reelId,
        comments_count: result.comments_count,
        commentsCount: result.comments_count,
      },
    });
  } catch (error) {
    return formatResponse({ res, success: false, message: error });
  }
};
