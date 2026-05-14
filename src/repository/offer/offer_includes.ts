import { Includeable } from "sequelize";
import Worker from "../../_models/worker/worker";
import Service from "../../_models/service/service";
import Category from "../../_models/category/category";
import { serviceInclude } from "../../repository/service/service_includes";
import { workerIncludes } from "../../repository/worker/worker_includes";
import User from "../../_models/user/user";
import StatusService from "../../_models/status/statusService";
const excludeKeys = ["createdAt", "updatedAt", "password"];

const offererLiteInclude: Includeable = {
  model: Worker,
  as: "offerer",
  include: [
    {
      model: User,
      as: "personal_data",
      attributes: [
        "id",
        "email",
        "name",
        "last_name",
        "username",
        "image_profil",
        "profile_verified",
        "profile_verification_status",
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
  ],
  attributes: { exclude: ["auth_token", ...excludeKeys] },
};

const serviceLiteInclude: Includeable = {
  model: Service,
  as: "service",
  attributes: { exclude: excludeKeys },
  include: [
    {
      model: User,
      as: "client",
      attributes: [
        "id",
        "name",
        "email",
        "last_name",
        "username",
        "image_profil",
        "rate",
        "profile_verified",
        "profile_verification_status",
      ],
    },
    {
      model: StatusService,
      as: "status",
      attributes: ["id", "status", "description"],
    },
    {
      model: Category,
      as: "category",
      attributes: ["id", "name", "es_name"],
    },
  ],
};

// Includes livianos para listados: evita árbol profundo service.offers/workers.
export const offerListInclude: Includeable[] = [offererLiteInclude, serviceLiteInclude];

// Include completo para detalle cuando sí se requiera todo el grafo.
export const offerInclude: Includeable[] = [
  {
    model: Worker,
    as: "offerer",
    include: [
      {
        model: User,
        as: "personal_data",
        attributes: [
          "id",
          "email",
          "name",
          "last_name",
          "username",
          "image_profil",
          "profile_verified",
          "profile_verification_status",
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
