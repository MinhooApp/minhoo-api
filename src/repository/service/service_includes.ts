
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
        attributes: { exclude: ["auth_token", ...excludeKeys] },
        include: [
            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
        ]
    }, {
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
                //include: userIncludes,
                attributes: { exclude: ["auth_token", ...excludeKeys] },
            }
        ],
        attributes: { exclude: excludeKeys },




    },
    {
        model: Worker,
        as: "workers",
        include: workerIncludes,
        attributes: { exclude: excludeKeys },
        through: { attributes: ["removed"] },
    }


];