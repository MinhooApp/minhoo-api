import { Includeable, Op, Sequelize } from "sequelize";
import Follower from "../../_models/follower/follower";

export const followIncludes: Includeable[] = [
    {
        model: Follower,
        as: "followers",
        //where: Sequelize.literal("`user->followers`.`userId`="),
        attributes: [

            "followerId" // Incluir el ID en la cláusula GROUP BY
        ],
        required: false

    },
    {
        model: Follower,
        as: "followings",
        // where: Sequelize.literal("`followings`.`followerId`= user.id"),
        attributes: [
            "userId" // Incluir el ID en la cláusula GROUP BY
        ],
        required: false
    },
];