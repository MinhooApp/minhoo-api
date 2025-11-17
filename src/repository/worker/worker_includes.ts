import { Includeable } from "sequelize";
import User from "../../_models/user/user";

import Plan from "../../_models/plan/plan";
import Category from "../../_models/category/category";
import MediaWorker from "../../_models/worker/media_worker";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const workerIncludes: Includeable[] = [
  {
    model: User,
    as: "personal_data",
    attributes: [
      "id",
      "name",
      "email",
      "last_name",
      "image_profil",
      "verified",
    ],
  },

  {
    model: Category,
    as: "categories",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
  },
  {
    model: Plan,
    as: "plan",
    attributes: { exclude: excludeKeys },
  },
  /*{
        model: MediaWorker,
        as: "worker_media",

        attributes: { exclude: excludeKeys },
    }*/
];
