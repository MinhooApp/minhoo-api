// user_includes.ts
import { Includeable } from "sequelize";
import Role from "../../_models/role/role";
import Plan from "../../_models/plan/plan";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import MediaWorker from "../../_models/worker/media_worker";
import { followIncludes } from "../follower/follower_include"; // <-- cambia import

const excludeKeys = ["createdAt", "updatedAt", "password"];
type UserIncludeOptions = {
  includeFollowGraph?: boolean;
};

/**
 * Devuelve SOLO los includes "hijos" de User.
 * No aplica el filtro de bloqueo aquí porque no existe el alias `user` en este nivel.
 * El filtro se aplica cuando incluyes al propio `User` desde el modelo padre.
 */
export const userIncludes = (
  meId: any = -1,
  options: UserIncludeOptions = {}
): Includeable[] => {
  const includeFollowGraph = options.includeFollowGraph !== false;
  const includes: Includeable[] = [
    {
      model: Role,
      as: "roles",
      attributes: { exclude: excludeKeys },
      through: { attributes: [] },
    },
    {
      model: Worker,
      as: "worker",
      where: { available: true },
      required: false,
      attributes: { exclude: excludeKeys },
      include: [
        {
          model: Category,
          as: "categories",
          attributes: { exclude: excludeKeys },
          through: { attributes: [] },
          // si esta colección te “explota” filas, puedes usar: separate: true
        },
        { model: Plan, as: "plan", attributes: { exclude: excludeKeys } },
        {
          model: MediaWorker,
          as: "worker_media",
          attributes: { exclude: excludeKeys },
          order: [["createdAt", "ASC"]],
          // opcional: separate: true
        },
      ],
    },
    {
      model: Category,
      as: "categories",
      attributes: { exclude: excludeKeys },
      through: { attributes: [] },
    },
  ];

  if (includeFollowGraph) {
    // followers / followings con filtro de bloqueos aplicado adentro
    includes.push(...followIncludes(meId));
  }

  return includes;
};
