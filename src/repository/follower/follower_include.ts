import { Includeable, Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";

/**
 * Incluye followers y followings, ocultando usuarios bloqueados con meId.
 * - followers: el "otro" es `user->followers`.`followerId`
 * - followings: el "otro" es `user->followings`.`userId`
 */
export const followIncludes = (meId: any = -1): Includeable[] => {
  const me = Number(meId);
  const hasViewer = Number.isInteger(me) && me > 0;

  // WHERE para followers (quiénes me siguen)
  const followersWhere = hasViewer
    ? {
        [Op.and]: [
          Sequelize.literal(`
            NOT EXISTS (
              SELECT 1
              FROM \`user_blocks\` ub
              WHERE
                (ub.blocker_id = ${me} AND ub.blocked_id = \`user->followers\`.\`followerId\`)
                OR
                (ub.blocker_id = \`user->followers\`.\`followerId\` AND ub.blocked_id = ${me})
            )
          `),
        ],
      }
    : undefined;

  // WHERE para followings (a quiénes sigo)
  const followingsWhere = hasViewer
    ? {
        [Op.and]: [
          Sequelize.literal(`
            NOT EXISTS (
              SELECT 1
              FROM \`user_blocks\` ub
              WHERE
                (ub.blocker_id = ${me} AND ub.blocked_id = \`user->followings\`.\`userId\`)
                OR
                (ub.blocker_id = \`user->followings\`.\`userId\` AND ub.blocked_id = ${me})
            )
          `),
        ],
      }
    : undefined;

  return [
    {
      model: Follower,
      as: "followers",
      attributes: ["followerId"],
      required: false, // mantiene LEFT JOIN
      ...(followersWhere ? { where: followersWhere } : {}),
      include: [
        {
          model: User,
          as: "follower_data",
          attributes: ["id", "name", "last_name", "image_profil"],
        },
      ],
      // optional: separate: true, // si esta lista te multiplica filas en listados grandes
    },
    {
      model: Follower,
      as: "followings",
      attributes: ["userId"],
      required: false,
      ...(followingsWhere ? { where: followingsWhere } : {}),
      include: [
        {
          model: User,
          as: "following_data",
          attributes: ["id", "name", "last_name", "image_profil"],
        },
      ],
      // optional: separate: true,
    },
  ];
};
