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
import { BlockUserRepository } from "../user/block_user_repository";
import { Op, Sequelize } from "sequelize";
const excludeKeys = ["createdAt ", "updatedAt ", "password "];
export const PROFILE_RECOMMENDATION_MESSAGE_PREFIX = "Suggested profile:";
export const PROFILE_RECOMMENDATION_NOTIFICATION_TYPE = "profile_recommendation";

type NotificationListCacheEntry = {
  expiresAtMs: number;
  version: number;
  data: any[];
};

type NotificationCountCacheEntry = {
  expiresAtMs: number;
  version: number;
  value: number;
};

const NOTIFICATION_LIST_CACHE_ENABLED =
  String(process.env.NOTIFICATION_LIST_CACHE_ENABLED ?? "1")
    .trim()
    .toLowerCase() !== "0";
const NOTIFICATION_LIST_CACHE_TTL_MS = Math.max(
  500,
  Number(process.env.NOTIFICATION_LIST_CACHE_TTL_MS ?? 3000) || 3000
);
const NOTIFICATION_COUNT_CACHE_TTL_MS = Math.max(
  500,
  Number(process.env.NOTIFICATION_COUNT_CACHE_TTL_MS ?? 2000) || 2000
);
const NOTIFICATION_CACHE_MAX_ENTRIES = Math.max(
  100,
  Number(process.env.NOTIFICATION_CACHE_MAX_ENTRIES ?? 5000) || 5000
);
const notificationListCache = new Map<string, NotificationListCacheEntry>();
const notificationCountCache = new Map<number, NotificationCountCacheEntry>();
const notificationUserCacheVersion = new Map<number, number>();

const getNotificationUserVersion = (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return 0;
  return Number(notificationUserCacheVersion.get(Math.trunc(userId)) ?? 0);
};

const buildNotificationListCacheKey = (params: {
  userId: number;
  cursor: number | null;
  limit: number;
  summary: boolean;
}) => {
  const cursorPart =
    Number.isFinite(Number(params.cursor)) && Number(params.cursor) > 0
      ? Math.trunc(Number(params.cursor))
      : 0;
  return `${Math.trunc(params.userId)}:${params.summary ? "s" : "f"}:${cursorPart}:${
    Math.trunc(params.limit)
  }`;
};

const pruneNotificationCaches = () => {
  const now = Date.now();

  for (const [key, entry] of notificationListCache.entries()) {
    if (entry.expiresAtMs <= now) {
      notificationListCache.delete(key);
    }
  }

  for (const [key, entry] of notificationCountCache.entries()) {
    if (entry.expiresAtMs <= now) {
      notificationCountCache.delete(key);
    }
  }

  while (notificationListCache.size > NOTIFICATION_CACHE_MAX_ENTRIES) {
    const firstKey = notificationListCache.keys().next().value;
    if (!firstKey) break;
    notificationListCache.delete(firstKey);
  }
};

export const invalidateNotificationCachesByUser = (userIdRaw: any) => {
  const userId = Number(userIdRaw);
  if (!Number.isFinite(userId) || userId <= 0) return;

  const safeUserId = Math.trunc(userId);
  const current = Number(notificationUserCacheVersion.get(safeUserId) ?? 0);
  notificationUserCacheVersion.set(safeUserId, current + 1);
  notificationCountCache.delete(safeUserId);
};

const withNotificationListCache = async (params: {
  userId: number;
  cursor: number | null;
  limit: number;
  summary: boolean;
  loader: () => Promise<any[]>;
}) => {
  if (!NOTIFICATION_LIST_CACHE_ENABLED) {
    return params.loader();
  }

  const now = Date.now();
  const version = getNotificationUserVersion(params.userId);
  const key = buildNotificationListCacheKey(params);
  const cached = notificationListCache.get(key);
  if (cached && cached.expiresAtMs > now && cached.version === version) {
    return cached.data;
  }

  const data = await params.loader();

  pruneNotificationCaches();
  notificationListCache.set(key, {
    expiresAtMs: now + NOTIFICATION_LIST_CACHE_TTL_MS,
    version,
    data,
  });

  return data;
};

const withNotificationCountCache = async (params: {
  userId: number;
  loader: () => Promise<number>;
}) => {
  if (!NOTIFICATION_LIST_CACHE_ENABLED) {
    return params.loader();
  }

  const now = Date.now();
  const safeUserId = Math.trunc(params.userId);
  const version = getNotificationUserVersion(safeUserId);
  const cached = notificationCountCache.get(safeUserId);
  if (cached && cached.expiresAtMs > now && cached.version === version) {
    return cached.value;
  }

  const value = await params.loader();
  notificationCountCache.set(safeUserId, {
    expiresAtMs: now + NOTIFICATION_COUNT_CACHE_TTL_MS,
    version,
    value,
  });
  return value;
};

const normalizeLimit = (value: any, fallback = 20, max = 20) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
};

export const add = async (body: any) => {
  const notification = await Notification.create(body);
  invalidateNotificationCachesByUser((notification as any)?.userId ?? body?.userId);
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
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) return [];
  const blockedUserIds = await BlockUserRepository.getAllBlockedIds(Math.trunc(safeId));
  const hasBlockedUsers = Array.isArray(blockedUserIds) && blockedUserIds.length > 0;

  return withNotificationListCache({
    userId: Math.trunc(safeId),
    cursor: Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : null,
    limit,
    summary: false,
    loader: async () => {
      const notification = await Notification.findAll({
        where: {
          userId: safeId,
          deleted: false,
          ...(Number.isFinite(cursor) && cursor > 0 ? { id: { [Op.lt]: Math.floor(cursor) } } : {}),
          ...(hasBlockedUsers ? { interactorId: { [Op.notIn]: blockedUserIds } } : {}),
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
                limit: 1,
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
        order: [["id", "DESC"]],
        limit,
      });
      return notification as any[];
    },
  });
};

export const myNotificationsSummary = async (
  id: number,
  opts?: { cursor?: number | null; limit?: number }
) => {
  const cursor = Number(opts?.cursor);
  const limit = normalizeLimit(opts?.limit, 20, 20);
  const safeId = Number(id);
  if (!Number.isFinite(safeId) || safeId <= 0) return [];
  const blockedUserIds = await BlockUserRepository.getAllBlockedIds(Math.trunc(safeId));
  const hasBlockedUsers = Array.isArray(blockedUserIds) && blockedUserIds.length > 0;

  return withNotificationListCache({
    userId: Math.trunc(safeId),
    cursor: Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : null,
    limit,
    summary: true,
    loader: async () =>
      (await Notification.findAll({
        where: {
          userId: safeId,
          deleted: false,
          ...(Number.isFinite(cursor) && cursor > 0 ? { id: { [Op.lt]: Math.floor(cursor) } } : {}),
          ...(hasBlockedUsers ? { interactorId: { [Op.notIn]: blockedUserIds } } : {}),
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
        order: [["id", "DESC"]],
        limit,
      })) as any[],
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
  if (notification) {
    invalidateNotificationCachesByUser(userId);
  }
  return [notification];
};

export const read = async (id: number) => {
  const target = await Notification.findOne({
    where: { id: id },
    attributes: ["id", "userId"],
  });
  const notification = await Notification.update(
    { read: true },
    { where: { id: id } }
  );
  if (target) {
    invalidateNotificationCachesByUser((target as any)?.userId);
  }
  return notification;
};

export const readAllByUser = async (userId: number) => {
  const notification = await Notification.update(
    { read: true },
    { where: { userId: userId } }
  );
  invalidateNotificationCachesByUser(userId);
  return notification;
};

export const countUnreadByUser = async (userId: number) => {
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) return 0;
  const blockedUserIds = await BlockUserRepository.getAllBlockedIds(Math.trunc(safeUserId));
  const hasBlockedUsers = Array.isArray(blockedUserIds) && blockedUserIds.length > 0;

  return withNotificationCountCache({
    userId: safeUserId,
    loader: async () =>
      Notification.count({
        where: {
          userId: safeUserId,
          deleted: false,
          read: false,
          ...(hasBlockedUsers ? { interactorId: { [Op.notIn]: blockedUserIds } } : {}),
        },
      }),
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

  const affected = await Notification.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ["id", "userId"],
  });

  const result = await Notification.update(
    { deleted: true, read: true },
    { where: { id: { [Op.in]: ids } } }
  );

  const userIds = Array.from(
    new Set(
      (affected || [])
        .map((entry: any) => Number((entry as any)?.userId ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.trunc(value))
    )
  );
  userIds.forEach((userId) => invalidateNotificationCachesByUser(userId));
  return result;
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
