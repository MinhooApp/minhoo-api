import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
} from "../_module/module";
import { emitProfileUpdatedRealtime } from "../_shared/profile_realtime";
import bcryptjs from "bcryptjs";
import sequelize from "../../../_db/connection";
import { Op } from "sequelize";
import User from "../../../_models/user/user";
import Worker from "../../../_models/worker/worker";
import MediaWorker from "../../../_models/worker/media_worker";
import Service from "../../../_models/service/service";
import Offer from "../../../_models/offer/offer";
import Service_Worker from "../../../_models/service/service_worker";
import Post from "../../../_models/post/post";
import MediaPost from "../../../_models/post/media_post";
import Comment from "../../../_models/comment/comment";
import Like from "../../../_models/like/like";
import Follower from "../../../_models/follower/follower";
import Notification from "../../../_models/notification/notification";
import UserBlock from "../../../_models/block/block";
import Message from "../../../_models/chat/message";
import Chat_User from "../../../_models/chat/chat_user";
import Reel from "../../../_models/reel/reel";
import ReelComment from "../../../_models/reel/reel_comment";
import ReelLike from "../../../_models/reel/reel_like";
import ReelSave from "../../../_models/reel/reel_save";
import ReelView from "../../../_models/reel/reel_view";
import ReelReport from "../../../_models/reel/reel_report";

const parseBlockedId = (req: Request): number | null => {
  const raw = (req.params as any)?.blocked_id;
  const blockedId = Number(raw);
  return Number.isFinite(blockedId) ? blockedId : null;
};

const parseFollowerId = (req: Request): number | null => {
  const raw =
    (req.params as any)?.followerId ??
    (req.params as any)?.id ??
    (req.body as any)?.followerId;
  const followerId = Number(raw);
  return Number.isFinite(followerId) ? followerId : null;
};

export const block_user = async (req: Request, res: Response) => {
  try {
    const blockedId = parseBlockedId(req);

    if (blockedId === null) {
      return formatResponse({
        res,
        success: false,
        message: { success: false, message: "blocked_id must be a valid number" },
      });
    }

    const response = await repository.block_user(req.userId, blockedId);

    return formatResponse({
      res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const unblock_user = async (req: Request, res: Response) => {
  try {
    const blockedId = parseBlockedId(req);

    if (blockedId === null) {
      return formatResponse({
        res,
        success: false,
        message: { success: false, message: "blocked_id must be a valid number" },
      });
    }

    const response = await repository.unblock_user(req.userId, blockedId);

    return formatResponse({
      res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const remove_follower = async (req: Request, res: Response) => {
  try {
    const followerId = parseFollowerId(req);
    const ownerId = Number(req.userId);

    if (followerId === null) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: { success: false, message: "followerId must be a valid number" },
      });
    }

    console.log(
      `[remove_follower] ownerId=${req.userId} followerId=${followerId}`
    );

    const result = await followerRepo.removeFollower(req.userId, followerId);

    console.log(
      `[remove_follower] result removed=${result.removed} rowsAffected=${(result as any).rowsAffected ?? 0} reason=${(result as any).reason ?? "ok"}`
    );

    if (!result.removed) {
      const notFound = result.reason === "follower_not_found";
      return formatResponse({
        res,
        success: false,
        code: notFound ? 404 : 409,
        message: {
          success: false,
          message: notFound
            ? "followerId not found"
            : "followerId does not belong to the user",
        },
      });
    }

    const ownerCounts = await followerRepo.getCounts(ownerId);
    const followerCounts = await followerRepo.getCounts(followerId);
    const relationship = await followerRepo.getRelationship(ownerId, followerId);
    const recipientIds = [ownerId, Number(followerId)];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: ownerId,
        counts: ownerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
      emitProfileUpdatedRealtime({
        userId: followerId,
        counts: followerCounts,
        targetUserIds: recipientIds,
        action: "follow_counts_updated",
      }),
    ]);

    return formatResponse({
      res,
      success: true,
      body: {
        removed: true,
        targetId: followerId,
        viewerId: ownerId,
        following: relationship.isFollowing,
        isFollowing: relationship.isFollowing,
        is_following: relationship.isFollowing,
        followed_by: relationship.isFollowedBy,
        isFollowedBy: relationship.isFollowedBy,
        is_followed_by: relationship.isFollowedBy,
        mutual: relationship.isMutual,
        isMutual: relationship.isMutual,
        is_mutual: relationship.isMutual,
        followersCount: ownerCounts.followersCount,
        followingCount: ownerCounts.followingCount,
        followingsCount: ownerCounts.followingCount,
        followers_count: ownerCounts.followersCount,
        following_count: ownerCounts.followingCount,
        followings_count: ownerCounts.followingCount,
      },
      message: "removed",
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};


export const unfollow_by_id = async (req: Request, res: Response) => {
  const rawId =
    (req.params as any)?.id ??
    (req.body as any)?.userId ??
    (req.body as any)?.id ??
    (req.body as any)?.targetId ??
    (req.query as any)?.userId ??
    (req.query as any)?.id ??
    (req.query as any)?.targetId;
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
      message: "you cannot unfollow yourself",
    });
  }

  try {
    await followerRepo.unfollowUser(targetId, req.userId);

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
        viewerId: Number(req.userId),
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
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const delete_account = async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    if (!password) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "password is required",
      });
    }

    const user = await repository.getUserById(req.userId);
    if (!user) {
      return formatResponse({
        res,
        success: false,
        code: 404,
        message: "user not found",
      });
    }

    const valid = bcryptjs.compareSync(String(password), user.password);
    if (!valid) {
      return formatResponse({
        res,
        success: false,
        code: 401,
        message: "invalid password",
      });
    }

    await sequelize.transaction(async (t) => {
      const userId = req.userId;
      const reason = (req.body as any)?.reason ?? null;
      const ip = (req.headers["x-forwarded-for"] as string) || req.ip || null;
      const now = new Date();

      await sequelize.query(
        "INSERT INTO deleted_accounts (user_id, email, name, deleted_at, reason, ip) VALUES (:user_id, :email, :name, NOW(), :reason, :ip)",
        {
          replacements: {
            user_id: userId,
            email: user.email ?? null,
            name: `${user.name ?? ""} ${user.last_name ?? ""}`.trim() || null,
            reason,
            ip,
          },
          transaction: t,
        }
      );

      const [workers, services, posts, reels] = await Promise.all([
        Worker.findAll({
          where: { userId },
          attributes: ["id"],
          transaction: t,
          raw: true,
        }),
        Service.findAll({
          where: { userId },
          attributes: ["id"],
          transaction: t,
          raw: true,
        }),
        Post.findAll({
          where: { userId },
          attributes: ["id"],
          transaction: t,
          raw: true,
        }),
        Reel.findAll({
          where: { userId },
          attributes: ["id"],
          transaction: t,
          raw: true,
        }),
      ]);

      const workerIds = workers
        .map((row: any) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      const serviceIds = services
        .map((row: any) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      const postIds = posts
        .map((row: any) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      const reelIds = reels
        .map((row: any) => Number(row?.id))
        .filter((id) => Number.isFinite(id) && id > 0);

      await User.update(
        {
          is_deleted: true,
          deleted_at: now,
          available: false,
          disabled: true,
          auth_token: null,
        },
        { where: { id: userId }, transaction: t }
      );

      await Worker.update(
        { available: false, visible: false, alert: false },
        { where: { userId }, transaction: t }
      );

      await Post.update(
        { is_delete: true, deleted_date: now },
        { where: { userId }, transaction: t }
      );

      await Service.update(
        { is_available: false },
        { where: { userId }, transaction: t }
      );

      await Reel.update(
        {
          is_delete: true,
          deleted_date: now,
          status: "failed",
        },
        { where: { userId }, transaction: t }
      );

      await Promise.all([
        Comment.update(
          { is_delete: true, deleted_date: now },
          { where: { userId }, transaction: t }
        ),
        ReelComment.update(
          { is_delete: true, deleted_date: now },
          { where: { userId }, transaction: t }
        ),
        Like.destroy({ where: { userId }, transaction: t }),
        ReelLike.destroy({ where: { userId }, transaction: t }),
        ReelSave.destroy({ where: { userId }, transaction: t }),
        ReelView.destroy({ where: { userId }, transaction: t }),
        ReelReport.destroy({ where: { reporterId: userId }, transaction: t }),
        Follower.destroy({
          where: { [Op.or]: [{ userId }, { followerId: userId }] },
          transaction: t,
        }),
        UserBlock.destroy({
          where: { [Op.or]: [{ blocker_id: userId }, { blocked_id: userId }] },
          transaction: t,
        }),
        Chat_User.destroy({ where: { userId }, transaction: t }),
        Message.update(
          {
            text: null,
            mediaUrl: null,
            mediaMime: null,
            mediaDurationMs: null,
            mediaSizeBytes: null,
            waveform: null,
            metadata: null,
            deletedBy: userId,
          },
          { where: { senderId: userId }, transaction: t }
        ),
      ]);

      if (workerIds.length > 0) {
        await Promise.all([
          MediaWorker.destroy({
            where: { workerId: { [Op.in]: workerIds } },
            transaction: t,
          }),
          Offer.update(
            { canceled: true, removed: true },
            { where: { workerId: { [Op.in]: workerIds } }, transaction: t }
          ),
          Service_Worker.update(
            { canceled: true, removed: true },
            { where: { workerId: { [Op.in]: workerIds } }, transaction: t }
          ),
        ]);
      }

      if (serviceIds.length > 0) {
        await Promise.all([
          Offer.update(
            { canceled: true, removed: true },
            { where: { serviceId: { [Op.in]: serviceIds } }, transaction: t }
          ),
          Service_Worker.update(
            { canceled: true, removed: true },
            { where: { serviceId: { [Op.in]: serviceIds } }, transaction: t }
          ),
          Notification.update(
            { deleted: true },
            { where: { serviceId: { [Op.in]: serviceIds } }, transaction: t }
          ),
        ]);
      }

      if (postIds.length > 0) {
        await Promise.all([
          Comment.update(
            { is_delete: true, deleted_date: now },
            { where: { postId: { [Op.in]: postIds } }, transaction: t }
          ),
          Like.destroy({
            where: { postId: { [Op.in]: postIds } },
            transaction: t,
          }),
          MediaPost.destroy({
            where: { postId: { [Op.in]: postIds } },
            transaction: t,
          }),
          Notification.update(
            { deleted: true },
            { where: { postId: { [Op.in]: postIds } }, transaction: t }
          ),
        ]);
      }

      if (reelIds.length > 0) {
        await Promise.all([
          ReelComment.update(
            { is_delete: true, deleted_date: now },
            { where: { reelId: { [Op.in]: reelIds } }, transaction: t }
          ),
          ReelLike.destroy({
            where: { reelId: { [Op.in]: reelIds } },
            transaction: t,
          }),
          ReelSave.destroy({
            where: { reelId: { [Op.in]: reelIds } },
            transaction: t,
          }),
          ReelView.destroy({
            where: { reelId: { [Op.in]: reelIds } },
            transaction: t,
          }),
          ReelReport.destroy({
            where: { reelId: { [Op.in]: reelIds } },
            transaction: t,
          }),
          Notification.update(
            { deleted: true },
            { where: { reelId: { [Op.in]: reelIds } }, transaction: t }
          ),
        ]);
      }

      await Notification.update(
        { deleted: true },
        {
          where: {
            [Op.or]: [{ userId }, { interactorId: userId }],
          },
          transaction: t,
        }
      );
    });

    return formatResponse({
      res,
      success: true,
      body: { deleted: true },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
