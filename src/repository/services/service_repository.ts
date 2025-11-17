import User from "../../_models/user/user";
import Service from "../../_models/service/service";
import Category from "../../_models/category/category";
import { Op, Sequelize } from "sequelize";
const excludeKeys = ["createdAt", "updatedAt", "password"];

const serviceInclude = [
  {
    model: User,
    as: "user",
    attributes: { exclude: excludeKeys },
  },
  {
    model: Category,
    as: "category",
    attributes: { exclude: excludeKeys },
  },
];
export const add = async (body: any) => {
  const service = await Service.create(body);
  const response = await Service.findByPk(
    service.id,

    { include: serviceInclude, attributes: { exclude: excludeKeys } }
  );
  return response;
};

export const gets = async (meId: any = -1) => {
  const service = await Service.findAll({
    where: {
      is_available: true,
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
  });
  return service;
};
export const get = async (id: any) => {
  const service = await Service.findOne({ where: { id: id } });
  return service;
};

export const update = async (id: any, body: any) => {
  const serviceTemp = await Service.findByPk(id);
  const service = await serviceTemp?.update(body);
  return [service];
};

export const deleteservice = async () => {
  const service = await Service.update({}, { where: { is_delete: 1 } });
  return service;
};
