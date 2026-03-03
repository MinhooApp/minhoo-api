import { Op, Sequelize } from "sequelize";
import Reel from "../../_models/reel/reel";
import ReelLike from "../../_models/reel/reel_like";
import ReelSave from "../../_models/reel/reel_save";
import ReelView from "../../_models/reel/reel_view";
import ReelComment from "../../_models/reel/reel_comment";
import User from "../../_models/user/user";
import { whereNotBlockedExists } from "../user/block_where";

const reelUserInclude = {
  model: User,
  as: "user",
  attributes: [
    "id",
    "name",
    "last_name",
    "username",
    "image_profil",
    "job_categories_labels",
  ],
};

const normalizeNumber = (value: any, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
};

const normalizeLimit = (value: any, fallback = 15, max = 40) => {
  const n = Math.floor(normalizeNumber(value, fallback));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = Math.floor(normalizeNumber(value, fallback));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const normalizeUserId = (value: any): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
};

const setDataValue = (row: any, key: string, value: any) => {
  if (!row) return;
  if (typeof row.setDataValue === "function") {
    row.setDataValue(key, value);
  } else {
    row[key] = value;
  }
};

const buildFeedWhere = (viewerIdRaw: any) => {
  const viewerId = normalizeUserId(viewerIdRaw);
  const blockedWhere: any = whereNotBlockedExists(viewerId, "`reel`.`userId`");

  if (!viewerId) {
    return {
      is_delete: false,
      visibility: "public",
      ...(blockedWhere || {}),
    };
  }

  const andClauses: any[] = [];
  const blockedAnd = blockedWhere?.[Op.and];
  if (Array.isArray(blockedAnd) && blockedAnd.length) {
    andClauses.push(...blockedAnd);
  }

  andClauses.push({
    [Op.or]: [{ visibility: "public" }, { userId: viewerId }],
  });

  return {
    is_delete: false,
    [Op.and]: andClauses,
  };
};

const attachInteractionFlags = async (viewerIdRaw: any, reels: any[]) => {
  const viewerId = normalizeUserId(viewerIdRaw);
  if (!Array.isArray(reels) || !reels.length) return;

  const reelIds = reels
    .map((reel) => Number(reel?.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!viewerId || !reelIds.length) {
    reels.forEach((reel) => {
      setDataValue(reel, "is_starred", false);
      setDataValue(reel, "is_liked", false);
      setDataValue(reel, "is_saved", false);
    });
    return;
  }

  const [likes, saves] = await Promise.all([
    ReelLike.findAll({
      where: { userId: viewerId, reelId: { [Op.in]: reelIds } },
      attributes: ["reelId"],
    }),
    ReelSave.findAll({
      where: { userId: viewerId, reelId: { [Op.in]: reelIds } },
      attributes: ["reelId"],
    }),
  ]);

  const liked = new Set<number>(likes.map((r: any) => Number(r.reelId)));
  const saved = new Set<number>(saves.map((r: any) => Number(r.reelId)));

  reels.forEach((reel) => {
    const reelId = Number(reel?.id);
    const isLiked = liked.has(reelId);
    const isSaved = saved.has(reelId);
    setDataValue(reel, "is_starred", isLiked);
    setDataValue(reel, "is_liked", isLiked);
    setDataValue(reel, "is_saved", isSaved);
  });
};

const recountLikes = async (reelId: number) => {
  const total = await ReelLike.count({ where: { reelId } });
  await Reel.update({ likes_count: total }, { where: { id: reelId } });
  return total;
};

const recountSaves = async (reelId: number) => {
  const total = await ReelSave.count({ where: { reelId } });
  await Reel.update({ saves_count: total }, { where: { id: reelId } });
  return total;
};

const recountComments = async (reelId: number) => {
  const total = await ReelComment.count({ where: { reelId, is_delete: false } });
  await Reel.update({ comments_count: total }, { where: { id: reelId } });
  return total;
};

export const createReel = async (body: any) => {
  return Reel.create(body);
};

export const listFeed = async (
  pageRaw: any,
  sizeRaw: any,
  viewerIdRaw: any,
  suggested = false
) => {
  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);
  const viewerId = normalizeUserId(viewerIdRaw);

  const where = buildFeedWhere(viewerId);
  const order: any[] = suggested
    ? [
        ["views_count", "DESC"],
        ["likes_count", "DESC"],
        ["comments_count", "DESC"],
        ["createdAt", "DESC"],
      ]
    : [["createdAt", "DESC"]];

  const reels = await Reel.findAndCountAll({
    where,
    include: [reelUserInclude],
    replacements: { meId: viewerId ?? -1 },
    order,
    distinct: true,
    limit: size,
    offset: page * size,
  });

  await attachInteractionFlags(viewerId, reels.rows);

  return {
    page,
    size,
    count: Number(reels.count || 0),
    rows: reels.rows,
  };
};

export const listMine = async (userIdRaw: any, pageRaw: any, sizeRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  if (!userId) {
    return { page: 0, size: 0, count: 0, rows: [] };
  }

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);

  const reels = await Reel.findAndCountAll({
    where: { is_delete: false, userId },
    include: [reelUserInclude],
    order: [["createdAt", "DESC"]],
    distinct: true,
    limit: size,
    offset: page * size,
  });

  await attachInteractionFlags(userId, reels.rows);

  return {
    page,
    size,
    count: Number(reels.count || 0),
    rows: reels.rows,
  };
};

export const getById = async (idRaw: any, viewerIdRaw: any) => {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return null;

  const viewerId = normalizeUserId(viewerIdRaw);
  const feedWhere = buildFeedWhere(viewerId);

  const reel = await Reel.findOne({
    where: {
      id,
      ...(feedWhere || {}),
    },
    include: [reelUserInclude],
    replacements: { meId: viewerId ?? -1 },
  });

  if (!reel) return null;
  await attachInteractionFlags(viewerId, [reel]);
  return reel;
};

export const deleteReel = async (idRaw: any, userIdRaw: any) => {
  const id = Number(idRaw);
  const userId = normalizeUserId(userIdRaw);
  if (!Number.isFinite(id) || id <= 0 || !userId) {
    return { notFound: true, forbidden: false };
  }

  const reel = await Reel.findByPk(id);
  if (!reel || reel.is_delete) return { notFound: true, forbidden: false };
  if (Number(reel.userId) !== userId) return { notFound: false, forbidden: true };

  await reel.update({ is_delete: true, deleted_date: new Date(new Date().toUTCString()) });
  return { notFound: false, forbidden: false, reel };
};

export const toggleStar = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, starred: false, likes_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, starred: false, likes_count: 0 };

  const existing = await ReelLike.findOne({ where: { userId, reelId } });
  let starred = false;
  if (existing) {
    await existing.destroy();
    starred = false;
  } else {
    await ReelLike.create({ userId, reelId });
    starred = true;
  }

  const likes_count = await recountLikes(reelId);
  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);

  return { notFound: false, starred, likes_count, reel: updatedReel };
};

export const saveReel = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, saved: false, created: false, saves_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, saved: false, created: false, saves_count: 0 };

  const [row, created] = await ReelSave.findOrCreate({
    where: { userId, reelId },
    defaults: { userId, reelId },
  });

  const saves_count = await recountSaves(reelId);
  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);

  return {
    notFound: false,
    saved: true,
    created,
    saves_count,
    row,
    reel: updatedReel,
  };
};

export const unsaveReel = async (userIdRaw: any, idRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  const reelId = Number(idRaw);

  if (!userId || !Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, saved: false, removed: false, saves_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, saved: false, removed: false, saves_count: 0 };

  const deleted = await ReelSave.destroy({ where: { userId, reelId } });
  const saves_count = await recountSaves(reelId);

  const updatedReel = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updatedReel ? [updatedReel] : []);

  return {
    notFound: false,
    saved: false,
    removed: deleted > 0,
    saves_count,
    reel: updatedReel,
  };
};

export const listSaved = async (userIdRaw: any, pageRaw: any, sizeRaw: any) => {
  const userId = normalizeUserId(userIdRaw);
  if (!userId) {
    return { page: 0, size: 0, count: 0, rows: [] };
  }

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 15, 40);

  const saves = await ReelSave.findAndCountAll({
    where: { userId },
    include: [
      {
        model: Reel,
        as: "reel",
        required: true,
        where: { is_delete: false },
        include: [reelUserInclude],
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: size,
    offset: page * size,
    distinct: true,
  });

  const rows = saves.rows
    .map((row: any) => row.reel)
    .filter((row: any) => !!row);

  await attachInteractionFlags(userId, rows);
  rows.forEach((row: any) => setDataValue(row, "is_saved", true));

  return {
    page,
    size,
    count: Number(saves.count || 0),
    rows,
  };
};

export const recordView = async (
  idRaw: any,
  userIdRaw: any,
  sessionKeyRaw: any
) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { found: false, counted: false, reel: null };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { found: false, counted: false, reel: null };

  const userId = normalizeUserId(userIdRaw);
  const sessionKey = String(sessionKeyRaw ?? "").trim();
  const viewedDate = new Date().toISOString().slice(0, 10);

  let created = false;

  if (userId) {
    const [, wasCreated] = await ReelView.findOrCreate({
      where: { reelId, userId, viewed_date: viewedDate },
      defaults: {
        reelId,
        userId,
        session_key: sessionKey || null,
        viewed_date: viewedDate,
      },
    });
    created = wasCreated;
  } else {
    if (!sessionKey) {
      const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
      return { found: true, counted: false, reel: updated };
    }

    const [, wasCreated] = await ReelView.findOrCreate({
      where: { reelId, session_key: sessionKey, viewed_date: viewedDate },
      defaults: {
        reelId,
        userId: null,
        session_key: sessionKey,
        viewed_date: viewedDate,
      },
    });
    created = wasCreated;
  }

  if (created) {
    await Reel.increment({ views_count: 1 }, { where: { id: reelId } });
  }

  const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(userId, updated ? [updated] : []);
  return { found: true, counted: created, reel: updated };
};

export const shareReel = async (idRaw: any, viewerIdRaw: any) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { found: false, reel: null };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { found: false, reel: null };

  await Reel.increment({ shares_count: 1 }, { where: { id: reelId } });
  const updated = await Reel.findByPk(reelId, { include: [reelUserInclude] });
  await attachInteractionFlags(viewerIdRaw, updated ? [updated] : []);

  return { found: true, reel: updated };
};

export const addComment = async (idRaw: any, userIdRaw: any, body: any) => {
  const reelId = Number(idRaw);
  const userId = normalizeUserId(userIdRaw);
  if (!Number.isFinite(reelId) || reelId <= 0 || !userId) {
    return { notFound: true, comment: null, comments_count: 0 };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, comment: null, comments_count: 0 };

  const payload = {
    reelId,
    userId,
    comment: body?.comment ?? null,
    media_url: body?.media_url ?? null,
    is_delete: false,
  };

  const comment = await ReelComment.create(payload);
  const comments_count = await recountComments(reelId);

  const hydrated = await ReelComment.findByPk(comment.id, {
    include: [
      {
        model: User,
        as: "comment_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
    ],
  });

  return { notFound: false, comment: hydrated ?? comment, comments_count };
};

export const listComments = async (idRaw: any, pageRaw: any, sizeRaw: any) => {
  const reelId = Number(idRaw);
  if (!Number.isFinite(reelId) || reelId <= 0) {
    return { notFound: true, page: 0, size: 0, count: 0, rows: [] };
  }

  const reel = await Reel.findOne({ where: { id: reelId, is_delete: false } });
  if (!reel) return { notFound: true, page: 0, size: 0, count: 0, rows: [] };

  const page = normalizePage(pageRaw, 0);
  const size = normalizeLimit(sizeRaw, 20, 50);

  const comments = await ReelComment.findAndCountAll({
    where: { reelId, is_delete: false },
    include: [
      {
        model: User,
        as: "comment_user",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
    ],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit: size,
    offset: page * size,
    distinct: true,
  });

  return {
    notFound: false,
    page,
    size,
    count: Number(comments.count || 0),
    rows: comments.rows,
  };
};

export const deleteComment = async (commentIdRaw: any, userIdRaw: any) => {
  const commentId = Number(commentIdRaw);
  const userId = normalizeUserId(userIdRaw);

  if (!Number.isFinite(commentId) || commentId <= 0 || !userId) {
    return { notFound: true, forbidden: false, removed: false, comments_count: 0 };
  }

  const comment = await ReelComment.findByPk(commentId);
  if (!comment) {
    return { notFound: true, forbidden: false, removed: false, comments_count: 0 };
  }

  if (comment.is_delete) {
    const comments_count = await ReelComment.count({
      where: { reelId: comment.reelId, is_delete: false },
    });
    return {
      notFound: false,
      forbidden: false,
      removed: false,
      reelId: comment.reelId,
      comments_count,
    };
  }

  const reel = await Reel.findByPk(comment.reelId, { attributes: ["id", "userId"] });
  const isOwner = Number(comment.userId) === userId;
  const isReelOwner = Number(reel?.userId) === userId;

  if (!isOwner && !isReelOwner) {
    return { notFound: false, forbidden: true, removed: false, comments_count: 0 };
  }

  await comment.update({
    is_delete: true,
    deleted_date: new Date(new Date().toUTCString()),
  });

  const comments_count = await recountComments(Number(comment.reelId));

  return {
    notFound: false,
    forbidden: false,
    removed: true,
    reelId: Number(comment.reelId),
    comments_count,
  };
};

export const getDownloadUrl = (reel: any) => {
  const allowDownload = Boolean(reel?.allow_download);
  if (!allowDownload) return null;

  const videoUid = String(reel?.video_uid ?? "").trim();
  const customDownload = String(reel?.download_url ?? "").trim();
  if (customDownload) return customDownload;
  if (videoUid) {
    return `/api/v1/media/video/download?uid=${encodeURIComponent(videoUid)}`;
  }
  const stream = String(reel?.stream_url ?? "").trim();
  return stream || null;
};
