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

const parsePositiveId = (value: any): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : null;
};

const parseFollowRelationId = (req: Request): number | null =>
  parsePositiveId(
    (req.body as any)?.followId ??
      (req.body as any)?.follow_id ??
      (req.body as any)?.followingId ??
      (req.body as any)?.following_id ??
      (req.body as any)?.relationId ??
      (req.body as any)?.relation_id ??
      (req.body as any)?.cursor_id ??
      (req.body as any)?.cursorId ??
      (req.query as any)?.followId ??
      (req.query as any)?.follow_id ??
      (req.query as any)?.followingId ??
      (req.query as any)?.following_id ??
      (req.query as any)?.relationId ??
      (req.query as any)?.relation_id ??
      (req.query as any)?.cursor_id ??
      (req.query as any)?.cursorId
  );

const resolveFollowTargetId = async (
  req: Request,
  viewerId: number,
  candidateIdRaw: any
): Promise<number | null> => {
  const explicitTargetId = parsePositiveId(
    (req.body as any)?.userId ??
      (req.body as any)?.targetId ??
      (req.body as any)?.followedId ??
      (req.body as any)?.followingUserId ??
      (req.query as any)?.userId ??
      (req.query as any)?.targetId ??
      (req.query as any)?.followedId ??
      (req.query as any)?.followingUserId
  );
  if (explicitTargetId) return explicitTargetId;

  const explicitRelationId = parseFollowRelationId(req);
  if (explicitRelationId) {
    const relationTargetId = await followerRepo.resolveCounterpartUserIdByRelationId(
      explicitRelationId,
      viewerId
    );
    if (relationTargetId) return relationTargetId;
  }

  const candidateId = parsePositiveId(candidateIdRaw);
  if (!candidateId) return null;

  const relationTargetId = await followerRepo.resolveCounterpartUserIdByRelationId(
    candidateId,
    viewerId
  );
  if (!relationTargetId) return candidateId;

  const candidateUser = await repository.getUserById(candidateId);
  if (!candidateUser || (candidateUser as any)?.disabled || (candidateUser as any)?.is_deleted) {
    return relationTargetId;
  }

  const candidateIsAdmin = await repository.isUserAdminById(candidateId);
  if (candidateIsAdmin) {
    return relationTargetId;
  }

  return candidateId;
};

const sendAdminActionForbidden = (
  req: Request,
  res: Response,
  params: { code: string; message: string; status?: number }
) => {
  const status = Number(params?.status ?? 403) || 403;
  const message = String(params?.message ?? "forbidden").trim() || "forbidden";
  const code = String(params?.code ?? "FORBIDDEN").trim() || "FORBIDDEN";
  const authenticated = Number(req.userId) > 0;
  return res.status(status).json({
    success: false,
    code,
    message,
    header: {
      success: false,
      authenticated,
      message,
      messages: [message],
    },
    messages: [message],
    body: { code },
  });
};

export const follow = async (req: Request, res: Response) => {
  const viewerId = Number(req.userId);
  const targetCandidateId = Number(
    (req.body as any)?.userId ??
      (req.body as any)?.id ??
      (req.body as any)?.targetId ??
      (req.body as any)?.followedId
  );

  try {
    const resolvedTargetId = await resolveFollowTargetId(req, viewerId, targetCandidateId);
    if (resolvedTargetId === null) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "userId must be a valid number",
      });
    }
    const targetId = resolvedTargetId;

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

    const targetIsAdmin = await repository.isUserAdminById(targetId);
    if (targetIsAdmin) {
      return sendAdminActionForbidden(req, res, {
        code: "ADMIN_NOT_FOLLOWABLE",
        message: "admin accounts cannot be followed",
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

    const { created, row } = await followerRepo.followUser(targetId, viewerId);
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
    void Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: [targetId],
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: viewerId,
        counts: viewerCounts,
        targetUserIds: [viewerId],
        action: "follow_counts_updated",
      }),
    ]).catch((error) => {
      console.error("[user/follow] realtime emit failed", error);
    });

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
        countsUserId: viewerId,
        followersCount: viewerCounts.followersCount,
        followingCount: viewerCounts.followingCount,
        followingsCount: viewerCounts.followingCount,
        followers_count: viewerCounts.followersCount,
        following_count: viewerCounts.followingCount,
        followings_count: viewerCounts.followingCount,
        targetCounts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        viewerCounts: {
          followersCount: viewerCounts.followersCount,
          followingCount: viewerCounts.followingCount,
          followingsCount: viewerCounts.followingCount,
          followers_count: viewerCounts.followersCount,
          following_count: viewerCounts.followingCount,
          followings_count: viewerCounts.followingCount,
        },
        targetFollowersCount: targetCounts.followersCount,
        targetFollowingCount: targetCounts.followingCount,
        viewerFollowersCount: viewerCounts.followersCount,
        viewerFollowingCount: viewerCounts.followingCount,
        action: created ? "followed" : "already_following",
        follower: {
          id: Number((row as any)?.id ?? 0) || null,
          userId: viewerId,
          followerId: viewerId,
          followingId: targetId,
          followedUserId: targetId,
          targetId,
        },
        refreshLists: ["followers", "following", "profile"],
        shouldRefreshFollowing: true,
      },
      message: created
        ? "Ahora sigues a este usuario"
        : "Ya sigues a este usuario",
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const follow_by_id = async (req: Request, res: Response) => {
  const viewerId = Number(req.userId);
  const rawId = (req.params as any)?.id;

  try {
    const resolvedTargetId = await resolveFollowTargetId(req, viewerId, rawId);
    if (resolvedTargetId === null) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "id must be a valid number",
      });
    }
    const targetId = resolvedTargetId;

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

    const targetIsAdmin = await repository.isUserAdminById(targetId);
    if (targetIsAdmin) {
      return sendAdminActionForbidden(req, res, {
        code: "ADMIN_NOT_FOLLOWABLE",
        message: "admin accounts cannot be followed",
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

    const { created, row } = await followerRepo.followUser(targetId, viewerId);

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
    void Promise.all([
      emitProfileUpdatedRealtime({
        userId: targetId,
        counts: targetCounts,
        targetUserIds: [targetId],
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: viewerId,
        counts: viewerCounts,
        targetUserIds: [viewerId],
        action: "follow_counts_updated",
      }),
    ]).catch((error) => {
      console.error("[user/follow_by_id] realtime emit failed", error);
    });

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
        countsUserId: viewerId,
        followersCount: viewerCounts.followersCount,
        followingCount: viewerCounts.followingCount,
        followingsCount: viewerCounts.followingCount,
        followers_count: viewerCounts.followersCount,
        following_count: viewerCounts.followingCount,
        followings_count: viewerCounts.followingCount,
        targetCounts: {
          followersCount: targetCounts.followersCount,
          followingCount: targetCounts.followingCount,
          followingsCount: targetCounts.followingCount,
          followers_count: targetCounts.followersCount,
          following_count: targetCounts.followingCount,
          followings_count: targetCounts.followingCount,
        },
        viewerCounts: {
          followersCount: viewerCounts.followersCount,
          followingCount: viewerCounts.followingCount,
          followingsCount: viewerCounts.followingCount,
          followers_count: viewerCounts.followersCount,
          following_count: viewerCounts.followingCount,
          followings_count: viewerCounts.followingCount,
        },
        targetFollowersCount: targetCounts.followersCount,
        targetFollowingCount: targetCounts.followingCount,
        viewerFollowersCount: viewerCounts.followersCount,
        viewerFollowingCount: viewerCounts.followingCount,
        action: created ? "followed" : "already_following",
        follower: {
          id: Number((row as any)?.id ?? 0) || null,
          userId: viewerId,
          followerId: viewerId,
          followingId: targetId,
          followedUserId: targetId,
          targetId,
        },
        refreshLists: ["followers", "following", "profile"],
        shouldRefreshFollowing: true,
      },
      message: created
        ? "Ahora sigues a este usuario"
        : "Ya sigues a este usuario",
    });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
