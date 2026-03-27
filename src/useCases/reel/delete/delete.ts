import { Request, Response, formatResponse, repository, socket } from "../_module/module";
import * as notificationRepository from "../../../repository/notification/notification_repository";
import {
  emitOrbitDeletedRealtime,
  emitNotificationDeletedRealtime,
  emitOrbitRingUpdatedRealtime,
} from "../../../libs/helper/realtime_dispatch";
import { getActiveOrbitStateByUser } from "../../../repository/reel/orbit_ring_projection";
import {
  bumpHomeContentCacheVersion,
  bumpHomeNotificationsCacheVersion,
} from "../../../libs/cache/bootstrap_home_cache_version";

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
    const ownerRingState = await getActiveOrbitStateByUser({
      userIdRaw: ownerId,
      viewerIdRaw: ownerId,
    });
    const ringSnapshot = {
      has_active_orbit: ownerRingState.hasActiveOrbit,
      hasActiveOrbit: ownerRingState.hasActiveOrbit,
      has_orbit_ring: ownerRingState.hasActiveOrbit,
      hasOrbitRing: ownerRingState.hasActiveOrbit,
      active_orbit_reel_id: ownerRingState.activeOrbitReelId,
      activeOrbitReelId: ownerRingState.activeOrbitReelId,
      orbit_ring_until: ownerRingState.orbitRingUntil,
      orbitRingUntil: ownerRingState.orbitRingUntil,
    };
    const payload = {
      action: "deleted",
      event: "reel_deleted",
      entity: "reel",
      deleteReason: "owner_delete",
      delete_reason: "owner_delete",
      reelId,
      reel_id: reelId,
      ownerId,
      owner_id: ownerId,
      actorUserId: Number(req.userId ?? 0) || ownerId,
      actor_user_id: Number(req.userId ?? 0) || ownerId,
      deletedAt,
      deleted_at: deletedAt,
      ui_hint: {
        remove_only: true,
        auto_open: false,
        auto_advance: false,
      },
      uiHint: {
        removeOnly: true,
        autoOpen: false,
        autoAdvance: false,
      },
      owner_has_active_orbit: ownerRingState.hasActiveOrbit,
      ownerHasActiveOrbit: ownerRingState.hasActiveOrbit,
      owner_has_orbit_ring: ownerRingState.hasActiveOrbit,
      ownerHasOrbitRing: ownerRingState.hasActiveOrbit,
      owner_active_orbit_reel_id: ownerRingState.activeOrbitReelId,
      ownerActiveOrbitReelId: ownerRingState.activeOrbitReelId,
      owner_orbit_ring_until: ownerRingState.orbitRingUntil,
      ownerOrbitRingUntil: ownerRingState.orbitRingUntil,
      ...ringSnapshot,
      user: {
        id: ownerId,
        userId: ownerId,
        user_id: ownerId,
        ...ringSnapshot,
      },
      reel: {
        ...(toPlainObject((result as any)?.reel) ?? {}),
        id: reelId,
        userId: ownerId,
        user_id: ownerId,
        is_delete: true,
        isDeleted: true,
        deleted: true,
        removed: true,
        ring_active: false,
        ringActive: false,
        ring_until: null,
        ringUntil: null,
        is_new: false,
        isNew: false,
        new_until: null,
        newUntil: null,
      },
    };

    emitOrbitDeletedRealtime(payload);

    emitOrbitRingUpdatedRealtime({
      action: "updated",
      user_id: ownerId,
      userId: ownerId,
      ...ringSnapshot,
      user: payload.user,
    });

    await bumpHomeContentCacheVersion();

    return formatResponse({
      res,
      success: true,
      body: {
        id: reelId,
        action: "deleted",
        deleted: true,
        reelId,
        reel_id: reelId,
        orbit_ring: ringSnapshot,
        reel: payload.reel,
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
    const updatedReel = reelId > 0 ? await repository.getById(reelId, req.userId) : null;
    const updatedReelPayload =
      updatedReel ??
      {
        id: reelId,
        comments_count: Number((result as any)?.comments_count ?? 0),
        commentsCount: Number((result as any)?.comments_count ?? 0),
      };
    socket.emit("reel/updated", {
      action: "comment_deleted",
      removed: Boolean((result as any)?.removed),
      reelId,
      reel_id: reelId,
      actorUserId: Number(req.userId ?? 0) || null,
      actor_user_id: Number(req.userId ?? 0) || null,
      commentId: Number(commentId),
      comment_id: Number(commentId),
      comments_count: Number((result as any)?.comments_count ?? 0),
      commentsCount: Number((result as any)?.comments_count ?? 0),
      updatedAt: deletedAt,
      updated_at: deletedAt,
      deletedAt,
      deleted_at: deletedAt,
      reel: updatedReelPayload,
    });

    const notifications = await notificationRepository.findActiveCommentNotifications({
      commentId: Number(commentId),
      reelId,
    });
    if (notifications.length > 0) {
      await notificationRepository.softDeleteByIds(
        notifications.map((notification: any) => Number((notification as any)?.id ?? 0))
      );
      const notificationUserIds = new Set<number>();
      notifications.forEach((notification: any) => {
        const notificationPayload = buildDeletedNotificationPayload(notification, deletedAt);
        const notificationUserId = Number(notificationPayload?.userId ?? 0);
        if (notificationUserId > 0) {
          notificationUserIds.add(notificationUserId);
          emitNotificationDeletedRealtime(notificationUserId, notificationPayload);
        }
      });
      await Promise.all(
        Array.from(notificationUserIds).map((userId) =>
          bumpHomeNotificationsCacheVersion(userId)
        )
      );
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
