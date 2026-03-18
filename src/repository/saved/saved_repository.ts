import { Op, Sequelize } from "sequelize";
import MediaPost from "../../_models/post/media_post";
import Post from "../../_models/post/post";
import SavedPost from "../../_models/post/saved_post";
import { postInclude } from "../post/post_include";

const normalizeLimit = (value: any, fallback = 20, max = 50) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
};

const normalizePage = (value: any, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

const normalizeCounter = (value: any) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

const setSavedFlag = (post: any, value: boolean) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("is_saved", value);
    return;
  }
  post.is_saved = value;
};

const setSavedCount = (post: any, count: number) => {
  if (!post) return;
  if (typeof post.setDataValue === "function") {
    post.setDataValue("saved_count", count);
    post.setDataValue("savedCount", count);
    return;
  }
  post.saved_count = count;
  post.savedCount = count;
};

const buildSavedPostsQuery = (videoOnly: boolean) => {
  const postIncludeForSaved: any = {
    model: Post,
    as: "post",
    attributes: ["id"],
    required: true,
    where: { is_delete: false },
  };

  if (videoOnly) {
    postIncludeForSaved.include = [
      {
        model: MediaPost,
        as: "post_media",
        attributes: [],
        where: { is_img: false },
        required: true,
      },
    ];
  }

  return postIncludeForSaved;
};

export const getVisiblePost = async (postId: number) => {
  return Post.findOne({
    where: { id: postId, is_delete: false },
    attributes: ["id", "userId", "is_delete", "saves_count", "likes_count"],
  });
};

export const savePost = async (userId: number, postId: number) => {
  const [row, created] = await SavedPost.findOrCreate({
    where: { userId, postId },
    defaults: { userId, postId },
  });

  if (created) {
    await Post.increment({ saves_count: 1 }, { where: { id: postId } });
  }

  const refreshed = await Post.findByPk(postId, {
    attributes: ["saves_count"],
  });

  return {
    row,
    created,
    savesCount: normalizeCounter((refreshed as any)?.saves_count),
  };
};

export const removeSavedPost = async (userId: number, postId: number) => {
  const deleted = await SavedPost.destroy({
    where: { userId, postId },
  });

  if (deleted > 0) {
    await Post.update(
      {
        saves_count: Sequelize.literal(
          "GREATEST(COALESCE(saves_count, 0) - 1, 0)"
        ),
      },
      { where: { id: postId } }
    );
  }

  const refreshed = await Post.findByPk(postId, {
    attributes: ["saves_count"],
  });

  return {
    removed: deleted > 0,
    savesCount: normalizeCounter((refreshed as any)?.saves_count),
  };
};

export const getSavedPostIdSet = async (userId: number, postIds: number[]) => {
  const normalizedIds = Array.from(
    new Set(
      (postIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  if (!Number.isFinite(userId) || userId <= 0 || !normalizedIds.length) {
    return new Set<number>();
  }

  const rows = await SavedPost.findAll({
    where: {
      userId,
      postId: { [Op.in]: normalizedIds },
    },
    attributes: ["postId"],
  });

  return new Set<number>(rows.map((row: any) => Number(row.postId)));
};

export const isPostSavedByUser = async (userId: number, postId: number) => {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  const row = await SavedPost.findOne({
    where: { userId, postId },
    attributes: ["id"],
  });
  return !!row;
};

export const countByPostId = async (postId: number) => {
  if (!Number.isFinite(postId) || postId <= 0) return 0;
  return SavedPost.count({ where: { postId } });
};

export const getSavedCountsMap = async (postIds: number[]) => {
  const normalizedIds = Array.from(
    new Set(
      (postIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const counts = new Map<number, number>();
  if (!normalizedIds.length) return counts;

  const rows = await SavedPost.findAll({
    where: { postId: { [Op.in]: normalizedIds } },
    attributes: [
      "postId",
      [SavedPost.sequelize!.fn("COUNT", SavedPost.sequelize!.col("id")), "total"],
    ],
    group: ["postId"],
  });

  rows.forEach((row: any) => {
    const postId = Number(row.postId);
    const total = Number(row.get?.("total") ?? row.dataValues?.total ?? 0);
    if (Number.isFinite(postId)) counts.set(postId, Number.isFinite(total) ? total : 0);
  });

  return counts;
};

export const removeByPostId = async (postId: number) => {
  if (!Number.isFinite(postId) || postId <= 0) return 0;
  return SavedPost.destroy({ where: { postId } });
};

const listSaved = async ({
  userId,
  page,
  size,
  videoOnly,
}: {
  userId: number;
  page: any;
  size: any;
  videoOnly: boolean;
}) => {
  const limit = normalizeLimit(size, 20, 50);
  const pageNumber = normalizePage(page, 0);
  const offset = pageNumber * limit;

  const savedRows = await SavedPost.findAndCountAll({
    where: { userId },
    include: [buildSavedPostsQuery(videoOnly)],
    attributes: ["id", "postId", "createdAt"],
    order: [
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  });

  const postIds = savedRows.rows
    .map((row: any) => Number(row.postId))
    .filter((id) => Number.isFinite(id));

  if (!postIds.length) {
    return {
      page: pageNumber,
      size: limit,
      count: Number(savedRows.count || 0),
      posts: [],
    };
  }

  const posts = await Post.findAll({
    where: {
      id: { [Op.in]: postIds },
      is_delete: false,
    },
    include: postInclude,
    attributes: { exclude: ["createdAt", "updatedAt"] },
  });

  const postById = new Map<number, any>();
  posts.forEach((post: any) => {
    postById.set(Number(post.id), post);
  });

  const orderedPosts = postIds
    .map((postId) => postById.get(postId))
    .filter(Boolean);

  orderedPosts.forEach((post: any) => setSavedFlag(post, true));
  orderedPosts.forEach((post: any) => {
    setSavedCount(post, normalizeCounter((post as any)?.saves_count));
  });

  return {
    page: pageNumber,
    size: limit,
    count: Number(savedRows.count || 0),
    posts: orderedPosts,
  };
};

export const listSavedPosts = async (userId: number, page: any, size: any) => {
  return listSaved({ userId, page, size, videoOnly: false });
};

export const listSavedVideos = async (userId: number, page: any, size: any) => {
  return listSaved({ userId, page, size, videoOnly: true });
};
