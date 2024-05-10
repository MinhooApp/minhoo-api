
import { Includeable } from 'sequelize';
import User from '../../_models/user/user';
import Role from "../../_models/role/role";
import { offerInclude } from "../../repository/offer/offer_includes";
import Category from '../../_models/category/category';
import Offer from '../../_models/offer/offer';
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
                model: User, as: "offerer",
                //include: userIncludes,
                attributes: { exclude: ["auth_token", ...excludeKeys] },
            }
        ],
        attributes: { exclude: excludeKeys },




    }


];