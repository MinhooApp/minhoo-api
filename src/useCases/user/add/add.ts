import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
  sendNotification,
} from "../_module/module";
import { emitProfileUpdatedRealtime } from "../_shared/profile_realtime";
import { BlockUserRepository } from "../../../repository/user/block_user_repository";

export const follow = async (req: Request, res: Response) => {
  const targetId = Number((req.body as any)?.userId);

  try {
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "userId must be a valid number",
      });
    }

    if (Number(req.userId) === targetId) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "you cannot follow yourself",
      });
    }

    const target = await repository.getUserById(targetId);
    if (!target || target.disabled || (target as any).is_deleted) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    const blockedEitherWay = await BlockUserRepository.isBlockedEitherWay(
      Number(req.userId),
      targetId
    );
    if (blockedEitherWay) {
      return formatResponse({
        res,
        success: false,
        code: 403,
        message: "you cannot follow this user",
      });
    }

    const response = await followerRepo.toggleFollow(targetId, req.userId);
    const myData = await repository.get(req.userId);
    if (response) {
      await sendNotification({
        followerId: req.userId,
        userId: targetId,
        interactorId: req.userId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

    const targetCounts = await followerRepo.getCounts(targetId);
    const viewerCounts = await followerRepo.getCounts(Number(req.userId));
    const recipientIds = [targetId, Number(req.userId)];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: req.userId,
        counts: viewerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
    ]);

    return formatResponse({
      res: res,
      success: true,
      body: { following: response },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const follow_by_id = async (req: Request, res: Response) => {
  const rawId = (req.params as any)?.id;
  const targetId = Number(rawId);

  if (!Number.isFinite(targetId)) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id must be a valid number",
    });
  }

  if (Number(req.userId) === targetId) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "you cannot follow yourself",
    });
  }

  try {
    const target = await repository.getUserById(targetId);
    if (!target || target.disabled || (target as any).is_deleted) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    const { created } = await followerRepo.followUser(targetId, req.userId);

    if (created) {
      const myData = await repository.get(req.userId);
      await sendNotification({
        followerId: req.userId,
        userId: targetId,
        interactorId: req.userId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

    const relationship = await followerRepo.getRelationship(req.userId, targetId);
    const targetCounts = await followerRepo.getCounts(targetId);
    const viewerCounts = await followerRepo.getCounts(req.userId);
    const recipientIds = [targetId, Number(req.userId)];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: req.userId,
        counts: viewerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
    ]);

    return formatResponse({
      res,
      success: true,
      body: {
        isFollowing: relationship.isFollowing,
        isFollowedBy: relationship.isFollowedBy,
        isMutual: relationship.isMutual,
        followersCount: targetCounts.followersCount,
        followingCount: viewerCounts.followingCount,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
