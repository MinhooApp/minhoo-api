import { Includeable } from "sequelize";
import Role from "../../_models/role/role";
import Plan from "../../_models/plan/plan";
import Worker from "../../_models/worker/worker";
import Category from "../../_models/category/category";
import MediaWorker from '../../_models/worker/media_worker';


const excludeKeys = ["createdAt", "updatedAt", "password"];
export const userIncludes: Includeable[] = [
    {
        model: Role,
        as: "roles",
        attributes: { exclude: excludeKeys },
        through: { attributes: [] },
    },
    {
        model: Worker,
        as: "worker",
        attributes: { exclude: excludeKeys },
        include: [

            {
                model: Category,
                as: "categories",
                attributes: {
                    exclude: excludeKeys,
                },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },
            },

            {
                model: MediaWorker,
                as: "worker_media",
                attributes: { exclude: excludeKeys },
            }
        ]
    },
    {
        model: Category,
        as: "categories",
        attributes: {
            exclude: excludeKeys,
        },
        through: { attributes: [] },

    },

]