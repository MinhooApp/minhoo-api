import Post from "../../_models/post/post";
import Like from "../../_models/like/like";
import { postInclude } from "./post_include";
import MediaPost from "../../_models/post/media_post";
import { Op, Sequelize } from "sequelize";

import { whereNotBlockedExists } from "../user/block_where";

const excludeKeys = ["createdAt", "updatedAt"];
const commentCountAttribute = [
  Sequelize.literal(
    "(SELECT COUNT(1) FROM comments c WHERE c.postId = `post`.`id` AND c.is_delete = 0)"
  ),
  "comments_count",
] as const;
const toCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

type MediaItem = { url: string; is_img: boolean };

const toBool = (value: any, fallback = true) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes"].includes(normalized)) return true;
    if (["0", "false", "no"].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeMediaPayload = (value: any): MediaItem[] => {
  if (value === undefined || value === null) return [];

  let source: any = value;
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        source = JSON.parse(trimmed);
      } catch {
        source = trimmed;
      }
    }
  }

  const items = Array.isArray(source) ? source : [source];
  const normalized = items
    .map((entry: any) => {
      if (typeof entry === "string") {
        const url = entry.trim();
        if (!url) return null;
        return { url, is_img: true };
      }

      if (!entry || typeof entry !== "object") return null;
      const url = String(entry.url ?? entry.media_url ?? "").trim();
      if (!url) return null;

      const type = String(entry.type ?? "").trim().toLowerCase();
      const inferredIsImg = type ? type !== "video" : true;
      const is_img = toBool(entry.is_img, inferredIsImg);

      return { url, is_img };
    })
    .filter((entry): entry is MediaItem => !!entry);

  const unique = new Map<string, MediaItem>();
  normalized.forEach((entry) => {
    unique.set(entry.url, entry);
  });

  return Array.from(unique.values());
};

export const add = async (body: any) => {
  const post: any = await Post.create(body);

  const mediaItems = normalizeMediaPayload(body.media_items ?? body.media_url);
  if (mediaItems.length) {
    await Promise.all(
      mediaItems.map(async (item) => {
        await MediaPost.create({
          postId: post.id,
          url: item.url,
          is_img: item.is_img,
        });
      })
    );
  }

  return post;
};

export const all = async () => {
  const post = await Post.findAll({
    include: postInclude,
  });
  return post;
};

export const gets = async (page: any = 0, size: any = 10, meId: any = -1) => {
  const option = {
    limit: +size,
    offset: +page * +size,
  };

  const post = await Post.findAndCountAll({
    where: {
      is_delete: false,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    ...option,
    include: postInclude,
    // ✅ siempre dejamos replacements (aunque no use :meId cuando meId inválido, no rompe)
    replacements: { meId },
    order: [["created_date", "DESC"]],
    attributes: { exclude: excludeKeys },
  });

  return post;
};

export const getsSuggested = async (
  page: any = 0,
  size: any = 10,
  meId: any = -1
) => {
  const option = {
    limit: +size,
    offset: +page * +size,
  };

  const where: any = {
    is_delete: false,
    ...whereNotBlockedExists(meId, "`post`.`userId`"),
  };

  const viewerId = Number(meId);
  if (Number.isFinite(viewerId) && viewerId > 0) {
    where.userId = { [Op.ne]: viewerId };
  }

  const post = await Post.findAndCountAll({
    where,
    ...option,
    include: postInclude,
    replacements: { meId },
    distinct: true,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
    order: [
      ["likes_count", "DESC"],
      [Sequelize.literal("comments_count"), "DESC"],
      ["created_date", "DESC"],
    ],
  });

  return post;
};

export const getOne = async (id: any, meId: any) => {
  const post = await Post.findOne({
    where: {
      id,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  return post;
};

export const get = async (id: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id,
      is_delete: false,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  return post;
};

export const getOneByUser = async (id: any, userId: any, meId: any = -1) => {
  const post = await Post.findOne({
    where: {
      id,
      userId,
      is_delete: false,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: {
      exclude: excludeKeys,
      include: [commentCountAttribute],
    },
  });

  return post;
};

export const update = async (id: any, body: any) => {
  const postTemp = await Post.findByPk(id, {
    include: postInclude,
    attributes: { exclude: excludeKeys },
  });

  const post = await postTemp?.update(body);
  return [post];
};

export const deletePost = async (id: any) => {
  const post = await Post.update({ is_delete: true }, { where: { id } });
  return post;
};

export const toggleLike = async (userId: any, postId: any) => {
  const postNumericId = Number(postId);
  if (!Number.isFinite(postNumericId) || postNumericId <= 0) {
    return { notFound: true, liked: false, likesCount: 0 };
  }

  const post = await Post.findOne({
    where: { id: postNumericId, is_delete: false },
    attributes: ["id", "likes_count"],
  });
  if (!post) {
    return { notFound: true, liked: false, likesCount: 0 };
  }

  const existingFollow = await Like.findOne({
    where: { userId, postId: postNumericId },
  });

  if (existingFollow) {
    await existingFollow.destroy();
    await Post.update(
      {
        likes_count: Sequelize.literal(
          "GREATEST(COALESCE(likes_count, 0) - 1, 0)"
        ),
      },
      { where: { id: postNumericId } }
    );

    const refreshed = await Post.findByPk(postNumericId, {
      attributes: ["likes_count"],
    });
    return {
      notFound: false,
      liked: false,
      likesCount: toCounter((refreshed as any)?.likes_count),
    };
  } else {
    await Like.create({ userId, postId: postNumericId });
    await Post.increment({ likes_count: 1 }, { where: { id: postNumericId } });

    const refreshed = await Post.findByPk(postNumericId, {
      attributes: ["likes_count"],
    });
    return {
      notFound: false,
      liked: true,
      likesCount: toCounter((refreshed as any)?.likes_count),
    };
  }
};

export const sharePost = async (postIdRaw: any) => {
  const postId = Number(postIdRaw);
  if (!Number.isFinite(postId) || postId <= 0) {
    return { found: false, sharesCount: 0 };
  }

  const post = await Post.findOne({
    where: { id: postId, is_delete: false },
    attributes: ["id", "shares_count"],
  });
  if (!post) {
    return { found: false, sharesCount: 0 };
  }

  await Post.increment({ shares_count: 1 }, { where: { id: postId } });

  const refreshed = await Post.findByPk(postId, {
    attributes: ["shares_count"],
  });

  return {
    found: true,
    sharesCount: toCounter((refreshed as any)?.shares_count),
  };
};
