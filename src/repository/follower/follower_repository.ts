import { Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";
const excludeKeys = ["createdAt", "updatedAt", "password"];
export const add = async (body: any) => {
  const follower = await Follower.create(body);
  return follower;
};

export const gets = async (meId: any = -1) => {
  const follower = await Follower.findAll({
    where: {
      [Op.and]: [
        Sequelize.literal(`
                  NOT EXISTS (
                    SELECT 1
                    FROM user_blocks ub
                    WHERE
                      (ub.blocker_id = :meId AND ub.blocked_id = \`follower\`.\`userId\`)
                      OR
                      (ub.blocker_id = \`follower\`.\`userId\` AND ub.blocked_id = :meId)
                  )
                `),
      ],
    },
    replacements: { meId },
  });
  return follower;
};
export const get = async (id: any, meId: any = -1) => {
  const follower = await Follower.findOne({
    where: {
      id: id,

      [Op.and]: [
        Sequelize.literal(`
                  NOT EXISTS (
                    SELECT 1
                    FROM user_blocks ub
                    WHERE
                      (ub.blocker_id = :meId AND ub.blocked_id = \`follower\`.\`userId\`)
                      OR
                      (ub.blocker_id = \`follower\`.\`userId\` AND ub.blocked_id = :meId)
                  )
                `),
      ],
    },
    replacements: { meId },
  });
  return follower;
};

export const update = async (id: any, body: any) => {
  const followerTemp = await Follower.findByPk(id);
  const follower = await followerTemp?.update(body);
  return [follower];
};

export const deletefollower = async () => {
  const follower = await Follower.update({}, { where: {} });
  return follower;
};
export const toggleFollow = async (userId: any, followerId: any) => {
  // Buscar si ya existe una fila con los IDs proporcionados
  const existingFollow = await Follower.findOne({
    where: {
      userId,
      followerId,
    },
  });

  if (existingFollow) {
    // Si existe, eliminar la fila para dejar de seguir
    await existingFollow.destroy();
    return false; // Ya no sigue al usuario
  } else {
    // Si no existe, crear una nueva fila para seguir al usuario
    await Follower.create({
      userId,
      followerId,
    });
    return true; // Empezó a seguir al usuario
  }
};
