import { Includeable } from "sequelize";
import Worker from "../../_models/worker/worker";
import Service from "../../_models/service/service";
import Category from "../../_models/category/category";
import { serviceInclude } from "../../repository/service/service_includes";
import { workerIncludes } from "../../repository/worker/worker_includes";
import User from "../../_models/user/user";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const offerInclude: Includeable[] = [
  {
    model: Worker,
    as: "offerer",
    include: [
      {
        model: User,
        as: "personal_data",
        attributes: ["id", "email", "name", "last_name", "image_profil"],
      },
      {
        model: Category,
        as: "categories",
        attributes: {
          exclude: excludeKeys,
        },
        through: { attributes: [] },
      },
    ],
    attributes: { exclude: ["auth_token", ...excludeKeys] },
  },
  {
    model: Service,
    as: "service",
    attributes: { exclude: excludeKeys },
    include: serviceInclude,
  },
];
