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
  const viewerId = Number(req.userId);
  const targetId = Number(
    (req.body as any)?.userId ??
      (req.body as any)?.id ??
      (req.body as any)?.targetId ??
      (req.body as any)?.followedId
  );

  try {
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "userId must be a valid number",
      });
    }

    if (viewerId === targetId) {
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
      viewerId,
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

    const { created } = await followerRepo.followUser(targetId, viewerId);
    const myData = await repository.get(viewerId);
    if (created) {
      await sendNotification({
        followerId: viewerId,
        userId: targetId,
        interactorId: viewerId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

    const targetCounts = await followerRepo.getCounts(targetId);
    const viewerCounts = await followerRepo.getCounts(viewerId);
    const recipientIds = [targetId, viewerId];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: viewerId,
        counts: viewerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
    ]);

    const relationship = await followerRepo.getRelationship(viewerId, targetId);

    return formatResponse({
      res: res,
      success: true,
      body: {
        following: relationship.isFollowing,
        isFollowing: relationship.isFollowing,
        is_following: relationship.isFollowing,
        followed_by: relationship.isFollowedBy,
        isFollowedBy: relationship.isFollowedBy,
        is_followed_by: relationship.isFollowedBy,
        mutual: relationship.isMutual,
        isMutual: relationship.isMutual,
        is_mutual: relationship.isMutual,
        targetId,
        viewerId,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        targetFollowersCount: targetCounts.followersCount,
        targetFollowingCount: targetCounts.followingCount,
        viewerFollowersCount: viewerCounts.followersCount,
        viewerFollowingCount: viewerCounts.followingCount,
        action: created ? "followed" : "already_following",
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const follow_by_id = async (req: Request, res: Response) => {
  const viewerId = Number(req.userId);
  const rawId = (req.params as any)?.id;
  const targetId = Number(rawId);

  if (!Number.isFinite(targetId) || targetId <= 0) {
    return formatResponse({
      res,
      success: false,
      code: 400,
      message: "id must be a valid number",
    });
  }

  if (viewerId === targetId) {
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

    const blockedEitherWay = await BlockUserRepository.isBlockedEitherWay(
      viewerId,
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

    const { created } = await followerRepo.followUser(targetId, viewerId);

    if (created) {
      const myData = await repository.get(viewerId);
      await sendNotification({
        followerId: viewerId,
        userId: targetId,
        interactorId: viewerId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

    const relationship = await followerRepo.getRelationship(viewerId, targetId);
    const targetCounts = await followerRepo.getCounts(targetId);
    const viewerCounts = await followerRepo.getCounts(viewerId);
    const recipientIds = [targetId, viewerId];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: viewerId,
        counts: viewerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
    ]);

    return formatResponse({
      res,
      success: true,
      body: {
        following: relationship.isFollowing,
        isFollowing: relationship.isFollowing,
        is_following: relationship.isFollowing,
        followed_by: relationship.isFollowedBy,
        isFollowedBy: relationship.isFollowedBy,
        is_followed_by: relationship.isFollowedBy,
        mutual: relationship.isMutual,
        isMutual: relationship.isMutual,
        is_mutual: relationship.isMutual,
        targetId,
        viewerId,
        followersCount: targetCounts.followersCount,
        followingCount: targetCounts.followingCount,
        followingsCount: targetCounts.followingCount,
        followers_count: targetCounts.followersCount,
        following_count: targetCounts.followingCount,
        followings_count: targetCounts.followingCount,
        targetFollowersCount: targetCounts.followersCount,
        targetFollowingCount: targetCounts.followingCount,
        viewerFollowersCount: viewerCounts.followersCount,
        viewerFollowingCount: viewerCounts.followingCount,
      },
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
