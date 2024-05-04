import { Includeable } from "sequelize";
import User from '../../_models/user/user';
import { userIncludes } from '../user/user_include';
import Service from '../../_models/service/service';
import Category from "../../_models/category/category";
import { serviceInclude } from "../../repository/service/service_includes";
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const offerInclude: Includeable[] = [
    {
        model: User,
        as: "offerer",
        include: userIncludes,
        attributes: { exclude: ["auth_token", ...excludeKeys] },
    },
    {
        model: Service,
        as: "service",
        attributes: { exclude: excludeKeys },
        include: serviceInclude

    }


];