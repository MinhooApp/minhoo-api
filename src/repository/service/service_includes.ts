
import { Includeable } from "sequelize";
import User from "../../_models/user/user";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import Offer from "../../_models/offer/offer";
import StatusService from "../../_models/status/statusService";
import { workerIncludes } from "../../repository/worker/worker_includes";

const excludeKeys = ["createdAt", "updatedAt", "password"] as const;

export const serviceInclude: Includeable[] = [
  {
    model: User,
    as: "client",
    attributes: ["id", "name", "email", "last_name", "username", "image_profil", "rate"],
  },
  {
    model: StatusService,
    as: "status",
    attributes: { exclude: [...excludeKeys] },
  },
  {
    model: Category,
    as: "category",
    attributes: { exclude: [...excludeKeys] },
  },

  {
    model: Offer,
    as: "offers",
    required: false, // 👈 explícito (no debe filtrar services sin offers)
    attributes: { exclude: [...excludeKeys] },
    include: [
      {
        model: Worker,
        as: "offerer",
        include: workerIncludes,
        attributes: { exclude: ["auth_token", ...excludeKeys] },
      },
    ],
    // ⚠️ No pongas where aquí si quieres ver offers canceladas también (historial/estado)
    // where: { canceled: false },
  },

  {
    model: Worker,
    as: "workers",
    required: false, // 👈 CLAVE: evita que el include se vuelva un filtro del Service
    attributes: { exclude: [...excludeKeys] },
    include: [
      {
        model: User,
        as: "personal_data",
        attributes: ["id", "name", "last_name", "username", "image_profil"],
      },
    ],
    through: {
      attributes: ["removed"],
      where: { removed: false },
    },
  },
];
