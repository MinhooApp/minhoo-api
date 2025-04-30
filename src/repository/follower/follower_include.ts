import { Includeable, Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";
import User from "../../_models/user/user";

export const followIncludes: Includeable[] = [
  {
    model: Follower,
    as: "followers",
    //where: Sequelize.literal("`user->followers`.`userId`="),
    include: [{ model: User, as: "follower_data" }],
    attributes: [
      "followerId", // Incluir el ID en la cláusula GROUP BY
    ],
    required: false,
  },
  {
    model: Follower,
    as: "followings",
    include: [{ model: User, as: "following_data" }],
    // where: Sequelize.literal("`followings`.`followerId`= user.id"),
    attributes: [
      "userId", // Incluir el ID en la cláusula GROUP BY
    ],
    required: false,
  },
];
