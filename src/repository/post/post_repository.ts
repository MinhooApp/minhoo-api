import Post from "../../_models/post/post";
import Like from "../../_models/like/like";
import { postInclude } from "./post_include";
import MediaPost from "../../_models/post/media_post";
import { Op } from "sequelize";

import { whereNotBlockedExists } from "../user/block_where";

const excludeKeys = ["createdAt", "updatedAt"];

export const add = async (body: any) => {
  const post: any = await Post.create(body);

  if (body.media_url != null) {
    await Promise.all(
      body.media_url.map(async (str: any) => {
        await MediaPost.create({
          postId: post.id,
          url: str,
          is_img: true,
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

export const getOne = async (id: any, meId: any) => {
  const post = await Post.findOne({
    where: {
      id,
      ...whereNotBlockedExists(meId, "`post`.`userId`"),
    },
    replacements: { meId },
    include: postInclude,
    attributes: { exclude: excludeKeys },
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
  const existingFollow = await Like.findOne({
    where: { userId, postId },
  });

  if (existingFollow) {
    await existingFollow.destroy();
    return false;
  } else {
    await Like.create({ userId, postId });
    return true;
  }
};
