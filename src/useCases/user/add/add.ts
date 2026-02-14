import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
  sendNotification,
} from "../_module/module";

export const follow = async (req: Request, res: Response) => {
  const { userId } = req.body;

  try {
    const response = await followerRepo.toggleFollow(userId, req.userId);
    const myData = await repository.get(req.userId);
    if (response) {
      await sendNotification({
        followerId: req.userId,
        userId: userId,
        interactorId: req.userId,
        type: "follow",
        message: `${myData!.name} ${myData!.last_name} started following you`,
      });
    }

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
