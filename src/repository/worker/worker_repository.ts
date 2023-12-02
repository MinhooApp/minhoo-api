import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import Plan from '../../_models/plan/plan';
import Category from '../../_models/category/category';
import Worker from '../../_models/worker/worker';
import generarJWT from '../../libs/helper/generate_jwt';
const excludeKeys = ["createdAt", "updatedAt", "password"];

const userIncludes = [
    {
        model: User,
        as: "personal_data",
        attributes: { exclude: excludeKeys },

    },

    {
        model: Category,
        as: "categories",
        attributes: { exclude: excludeKeys },
        through: { attributes: [] },
    },
    {
        model: Plan,
        as: "plan",
        attributes: { exclude: excludeKeys },
    },]


export const gets = async () => {
    const user = await Worker.findAll({
        where: { available: true }, include: userIncludes,
    });
    return user;
}

export const workers = async (page: any, size: any) => {
    let option = {
        limit: +size,
        offset: (+page) * (+size)
    }
    const workers = await Worker.findAndCountAll(
        {
            where: { available: 1 },
            ...option,
            include: userIncludes,
            attributes: { exclude: excludeKeys },

        }

    );
    return workers;
}
