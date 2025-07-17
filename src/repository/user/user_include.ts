import { Includeable } from "sequelize";
import Role from "../../_models/role/role";
import Plan from "../../_models/plan/plan";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import MediaWorker from "../../_models/worker/media_worker";
import sequelize from "../../_db/connection";
import User from "../../_models/user/user";
import { followIncludes } from "../follower/follower_include";

const excludeKeys = ["createdAt", "updatedAt", "password"];
export const userIncludes: Includeable[] = [
  {
    model: Role,
    as: "roles",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
  },
  {
    model: Worker,
    as: "worker",
    attributes: { exclude: excludeKeys },
    include: [
      {
        model: Category,
        as: "categories",
        attributes: {
          exclude: excludeKeys,
        },
        through: { attributes: [] },
      },
      {
        model: Plan,
        as: "plan",
        attributes: { exclude: excludeKeys },
      },

      {
        model: MediaWorker,
        as: "worker_media",
        attributes: { exclude: excludeKeys },
        order: [["createdAt", "ASC"]],
      },
    ],
  },
  {
    model: Category,
    as: "categories",
    attributes: {
      exclude: excludeKeys,
    },
    through: { attributes: [] },
  },
  ...followIncludes,
];
