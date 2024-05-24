
import { Includeable } from 'sequelize';
import User from '../../_models/user/user';
import Role from "../../_models/role/role";
import Worker from "../../_models/worker/worker";
import Category from '../../_models/category/category';
import Offer from '../../_models/offer/offer';
import StatusService from '../../_models/status/statusService';
import { workerIncludes } from '../../repository/worker/worker_includes';
const excludeKeys = ["createdAt", "updatedAt", "password"];
export const serviceInclude: Includeable[] = [
    {
        model: User,
        as: "client",
        attributes: ["id", "name", "last_name", "image_profil", "rate"]
    },
    {
        model: StatusService,
        as: "status",
        attributes: { exclude: excludeKeys },
    },
    {

        model: Category,
        as: "category",
        attributes: { exclude: excludeKeys },
    },

    {

        model: Offer,
        as: "offers",
        include: [
            {
                model: Worker, as: "offerer",
                include: workerIncludes,
                attributes: { exclude: ["auth_token", ...excludeKeys] },
                // where: { removed: false }
            }
        ],
        attributes: { exclude: excludeKeys },




    },
    {
        model: Worker,
        as: "workers",
        include: [
            {
                model: User,
                as: "personal_data",
                attributes: ["id", "name", "last_name", "image_profil"],
            },
        ],
        attributes: { exclude: excludeKeys },
        through: { attributes: ["removed"], where: { removed: false } },
    }


];