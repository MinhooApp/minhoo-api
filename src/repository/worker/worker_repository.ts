import User from "../../_models/user/user";
import Category from "../../_models/category/category";
import Worker from "../../_models/worker/worker";
import { workerIncludes } from "./worker_includes";
import { Op, Sequelize } from "sequelize";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const add = async (body: any) => {
  const worker = await Worker.create(body);
  return worker;
};
export const gets = async () => {
  const worker = await Worker.findAll({
    where: { available: true, visible: true },
    include: workerIncludes,
  });
  return worker;
};

export const workers = async (page: any, size: any, meId: any = -1) => {
  const option = {
    limit: +size,
    offset: +page * +size,
  };

  const workers = await Worker.findAndCountAll({
    where: {
      available: true,
      visible: true,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`worker\`.\`userId\`)
              OR
              (ub.blocker_id = \`worker\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    ...option,
    replacements: { meId },
    include: workerIncludes,
    attributes: { exclude: excludeKeys },
    order: Sequelize.literal("RAND()"), // Ordenar aleatoriamente usando literal
  });

  return workers;
};

export const update = async (id: any, body: any) => {
  const workerTemp = await Worker.findOne({
    where: { id: id },
    include: workerIncludes,
  });

  const worker = await workerTemp?.update(body);
  // Obtener las categorías actuales del trabajador
  const currentCategories = await worker?.getCategories();
  // Eliminar las categorías actuales del trabajador
  await worker?.removeCategories(currentCategories);
  // Asociar las nuevas categorías al trabajador
  await worker?.addCategories(body.categories);
  return worker;
};
export const visibleProfile = async (id: any, body: any) => {
  const workerTemp = await Worker.findOne({
    where: { userId: id },
    include: workerIncludes,
  });
  const ressponse = await workerTemp?.update(body);
  return ressponse;
};
export const worker = async (id: any, meId: any = -1) => {
  const worker = await Worker.findOne({
    where: {
      userId: id,
      available: true,
      [Op.and]: [
        Sequelize.literal(`
          NOT EXISTS (
            SELECT 1
            FROM user_blocks ub
            WHERE
              (ub.blocker_id = :meId AND ub.blocked_id = \`worker\`.\`userId\`)
              OR
              (ub.blocker_id = \`worker\`.\`userId\` AND ub.blocked_id = :meId)
          )
        `),
      ],
    },
    replacements: { meId },
    include: workerIncludes,
    attributes: { exclude: excludeKeys },
  });
  return worker;
};

export const tokensByNewService = async (categoryId: any, meId: any) => {
  const rows = await Worker.findAll({
    include: [
      {
        model: Category,
        attributes: [],
        required: true,
        where: {
          [Op.or]: [{ id: categoryId }, { name: "all" }],
        },
        through: { attributes: [] }, // oculta columnas de la tabla pivote
      },
      {
        model: User,
        as: "personal_data",
        attributes: ["uuid"],
        required: true,
        where: {
          alert: true,
          id: { [Op.ne]: meId },
        },
      },
    ],
    attributes: [], // no retornar columnas de Worker

    subQuery: false, // mejor JOIN en includes
  });

  const uuids = Array.from(
    new Set(rows.map((w: any) => w.personal_data?.uuid).filter(Boolean))
  );
  return uuids;
};
export const deleteImageProfil = async (id: any) => {
  return await User.update(
    { image_profil: "\\uploads\\images\\user\\profile\\profile.png" },
    { where: { id: id } }
  );
};
