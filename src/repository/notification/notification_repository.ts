import User from "../../_models/user/user";
import Like from "../../_models/like/like";
import Post from "../../_models/post/post";
import Reel from "../../_models/reel/reel";
import Offer from "../../_models/offer/offer";
import Worker from "../../_models/worker/worker";
import Message from "../../_models/chat/message";
import Service from "../../_models/service/service";
import MediaPost from "../../_models/post/media_post";
import Notification from "../../_models/notification/notification";
import { Op, Sequelize } from "sequelize";
const excludeKeys = ["createdAt ", "updatedAt ", "password "];
export const PROFILE_RECOMMENDATION_MESSAGE_PREFIX = "Suggested profile:";
export const PROFILE_RECOMMENDATION_NOTIFICATION_TYPE = "profile_recommendation";
const normalizeLimit = (value: any, fallback = 20, max = 20) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
};

export const add = async (body: any) => {
  const notification = await Notification.create(body);
  return notification;
};

export const gets = async () => {
  const notification = await Notification.findAll({
    where: {},
  });
  return notification;
};

export const myNotifications = async (
  id: number,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const cursor = Number(opts?.cursor);
  const limit = normalizeLimit(opts?.limit, 20, 20);
  const notification = await Notification.findAll({
    where: {
      userId: id,
      deleted: false,
      ...(Number.isFinite(cursor) && cursor > 0 ? { id: { [Op.lt]: Math.floor(cursor) } } : {}),
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :id AND ub.blocked_id = \`notification\`.\`interactorId\`)
              OR
              (ub.blocker_id = \`notification\`.\`interactorId\` AND ub.blocked_id = :id)
          )
        `),
      ],
    },
    attributes: [
      "id",
      "userId",
      "interactorId",
      "serviceId",
      "offerId",
      "postId",
      "reelId",
      "likerId",
      [Sequelize.col("notification.likerId"), "likeId"],
      "messageId",
      "type",
      "message",
      "read",
      "deleted",
      "notification_date",
    ],
    include: [
      {
        model: User,
        as: "interactor",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
      {
        model: Service,
        as: "service",
        attributes: [
          "id",
          "userId",
          "description",
          "rate",
          "currencyCode",
          "currencyPrefix",
          "service_date",
          "statusId",
        ],
      },
      {
        model: Offer,
        as: "offer",
        attributes: ["id", "serviceId", "workerId"],
        include: [
          {
            model: Service,
            as: "service",
            attributes: [
              "id",
              "description",
              "rate",
              "currencyCode",
              "currencyPrefix",
              "statusId",
            ],
          },
          {
            model: Worker,
            as: "offerer",
            attributes: ["id", "userId", "rate", "available", "visible"],
          },
        ],
      },
      {
        model: Post,
        as: "post",
        attributes: ["id", "userId"],
        include: [
          {
            model: MediaPost,
            as: "post_media",
            attributes: ["url", "is_img"],
            order: [["createdAt", "ASC"]],
            required: false,
            separate: true,
          },
        ],
      },
      {
        model: Reel,
        as: "reel",
        attributes: ["id", "userId", "thumbnail_url", "description", "video_uid", "stream_url"],
      },
      {
        model: Like,
        as: "like",
        attributes: ["id", "userId", "postId"],
      },
      {
        model: Message,
        as: "message_received",
        attributes: ["id", "senderId", "text"],
      },
    ],
    replacements: { id },
    order: [["notification_date", "DESC"]],
    limit,
  });
  return notification;
};

export const myNotificationsSummary = async (
  id: number,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const cursor = Number(opts?.cursor);
  const limit = normalizeLimit(opts?.limit, 20, 20);

  return Notification.findAll({
    where: {
      userId: id,
      deleted: false,
      ...(Number.isFinite(cursor) && cursor > 0 ? { id: { [Op.lt]: Math.floor(cursor) } } : {}),
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :id AND ub.blocked_id = \`notification\`.\`interactorId\`)
              OR
              (ub.blocker_id = \`notification\`.\`interactorId\` AND ub.blocked_id = :id)
          )
        `),
      ],
    },
    attributes: [
      "id",
      "interactorId",
      "serviceId",
      "offerId",
      "postId",
      "reelId",
      "messageId",
      "type",
      "read",
      "notification_date",
    ],
    include: [
      {
        model: User,
        as: "interactor",
        attributes: ["id", "name", "last_name", "username", "image_profil", "verified"],
      },
      {
        model: Service,
        as: "service",
        attributes: ["id", "description", "rate"],
      },
      {
        model: Offer,
        as: "offer",
        attributes: ["id", "serviceId"],
      },
      {
        model: Post,
        as: "post",
        attributes: ["id", "post"],
      },
      {
        model: Reel,
        as: "reel",
        attributes: ["id", "description", "thumbnail_url"],
      },
      {
        model: Message,
        as: "message_received",
        attributes: ["id", "text"],
      },
    ],
    replacements: { id },
    order: [["notification_date", "DESC"]],
    limit,
  });
};
export const get = async (id: any) => {
  const notification = await Notification.findOne({ where: { id: id } });
  return notification;
};

export const update = async (userId: number, id: any, body: any) => {
  const notificationTemp = await Notification.findOne({
    where: {
      userId: userId,
      id: id,
    },
  });
  const notification = await notificationTemp?.update(body);
  return [notification];
};

export const read = async (id: number) => {
  const notification = await Notification.update(
    { read: true },
    { where: { id: id } }
  );
  return notification;
};

export const readAllByUser = async (userId: number) => {
  const notification = await Notification.update(
    { read: true },
    { where: { userId: userId } }
  );
  return notification;
};

export const countUnreadByUser = async (userId: number) => {
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return 0;

  return Notification.count({
    where: {
      userId: safeUserId,
      deleted: false,
      read: false,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = ${safeUserId} AND ub.blocked_id = \`notification\`.\`interactorId\`)
              OR
              (ub.blocker_id = \`notification\`.\`interactorId\` AND ub.blocked_id = ${safeUserId})
          )
        `),
      ],
    },
  });
};


type CommentNotificationLookupParams = {
  commentId: number;
  postId?: number;
  reelId?: number;
};

export const findActiveCommentNotifications = async (
  params: CommentNotificationLookupParams
) => {
  const commentId = Number(params.commentId ?? 0);
  if (!Number.isFinite(commentId) || commentId <= 0) return [];

  const where: any = {
    type: "comment",
    deleted: false,
    commentId,
  };

  const postId = Number(params.postId ?? 0);
  if (Number.isFinite(postId) && postId > 0) {
    where.postId = postId;
  }

  const reelId = Number(params.reelId ?? 0);
  if (Number.isFinite(reelId) && reelId > 0) {
    where.reelId = reelId;
  }

  return Notification.findAll({
    where,
    attributes: [
      "id",
      "userId",
      "interactorId",
      "postId",
      "reelId",
      "commentId",
      "type",
      "message",
      "read",
      "deleted",
      "notification_date",
    ],
  });
};

export const softDeleteByIds = async (idsRaw: Array<number | string | null | undefined>) => {
  const ids = Array.from(
    new Set(
      (idsRaw || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
    )
  );

  if (!ids.length) return [0];

  return Notification.update(
    { deleted: true, read: true },
    { where: { id: { [Op.in]: ids } } }
  );
};

export const hasRecentProfileRecommendationNotification = async ({
  userId,
  sinceDate,
}: {
  userId: number;
  sinceDate: Date;
}) => {
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return false;
  if (!(sinceDate instanceof Date) || Number.isNaN(sinceDate.getTime())) return false;

  const count = await Notification.count({
    where: {
      userId: safeUserId,
      deleted: false,
      notification_date: { [Op.gte]: sinceDate },
      [Op.or]: [
        { type: PROFILE_RECOMMENDATION_NOTIFICATION_TYPE },
        {
          type: "admin",
          message: { [Op.like]: `${PROFILE_RECOMMENDATION_MESSAGE_PREFIX}%` },
        },
      ],
    },
  });

  return Number(count) > 0;
};
