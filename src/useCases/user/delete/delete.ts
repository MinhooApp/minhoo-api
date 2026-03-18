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
import Chat from "../../../_models/chat/chat";
import Chat_User from "../../../_models/chat/chat_user";

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

    const ownerCounts = await followerRepo.getCounts(req.userId);
    const followerCounts = await followerRepo.getCounts(followerId);
    const recipientIds = [Number(req.userId), Number(followerId)];

    await Promise.all([
      emitProfileUpdatedRealtime({
        userId: req.userId,
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
        followersCount: ownerCounts.followersCount,
      },
      message: "removed",
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};


export const unfollow_by_id = async (req: Request, res: Response) => {
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
        isFollowing: relationship.isFollowing,
        isFollowedBy: relationship.isFollowedBy,
        isMutual: relationship.isMutual,
        followersCount: targetCounts.followersCount,
        followingCount: viewerCounts.followingCount,
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

      await User.update(
        {
          is_deleted: true,
          deleted_at: new Date(),
          available: false,
          disabled: true,
          auth_token: null,
        },
        { where: { id: userId }, transaction: t }
      );

      await Worker.update(
        { available: false, visible: false },
        { where: { userId }, transaction: t }
      );

      await Post.update(
        { is_delete: true, deleted_date: new Date() },
        { where: { userId }, transaction: t }
      );

      await Service.update(
        { is_available: false },
        { where: { userId }, transaction: t }
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
