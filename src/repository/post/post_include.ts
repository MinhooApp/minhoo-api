import { Includeable } from "sequelize";
import User from "../../_models/user/user";
import Comment from "../../_models/comment/comment";
import { userIncludes } from "../user/user_include";
import MediaPost from "../../_models/post/media_post";
import Category from "../../_models/category/category";
import { followIncludes } from "../follower/follower_include";
import Like from "../../_models/like/like";
const excludeKeys = ["createdAt", "updatedAt", "password"];
const galeryInclude: Includeable[] = [
  {
    model: Category,
    as: "categories",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
  },
];
const userInclude: Includeable = {
  model: User,
  as: "user",
  include: [...followIncludes, ...galeryInclude, ...userIncludes],
  attributes: [
    "id",
    "name",
    "last_name",
    "email",
    "image_profil",
    "verified",
    "available",
  ],

  //
};

export const postInclude: Includeable[] = [
  userInclude,
  {
    model: MediaPost,
    as: "post_media",
    attributes: ["url", "is_img"],
    order: [["createdAt", "ASC"]],
    required: false,
    separate: true,
  },

  {
    model: Comment,
    as: "comments",
    attributes: ["id", "userId", "comment", "media_url", "created_date"],
    where: { is_delete: false },
    separate: true, // necesario para ordenar en include
    order: [["created_date", "DESC"]],
    required: false,

    include: [
      {
        model: User,
        as: "commentator",
        attributes: ["id", "name", "last_name", "image_profil"],
        required: false,
      },
    ],
  },
  {
    model: Like,
    as: "likes",
    attributes: ["id", "userId"],
  },
];
