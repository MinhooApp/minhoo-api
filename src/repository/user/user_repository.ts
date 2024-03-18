import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import Plan from '../../_models/plan/plan';
import Category from '../../_models/category/category';
import Worker from '../../_models/worker/worker';
import generarJWT from '../../libs/helper/generate_jwt';
const excludeKeys = ["createdAt", "updatedAt", "password"];


const userIncludes = [{
    model: Role,
    as: "roles",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
},
{
    model: Worker,
    as: "worker",
    attributes: { exclude: excludeKeys },
    include: [{
        model: Category,
        as: "categories",
        attributes: {
            exclude: excludeKeys,
        },
        through: { attributes: [] },
    }]
},
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

]



export const gets = async () => {
    const user = await User.findAll({
        where: { available: true }, include: userIncludes,
    });
    return user;
}

export const users = async (page: any = 0, size: any = 10) => {
    let option = {
        limit: +size,
        offset: (+page) * (+size)
    }
    const users = await User.findAndCountAll(
        {
            where: { available: 1 },
            ...option,
            include: userIncludes

        }

    );
    return users;
}

export const get = async (id: any) => {
    const user = await User.findOne({
        where: { id: id }, include: userIncludes,
    });
    return user;
}

export const update = async (id: any, body: any) => {
    const userTemp = await User.findOne({
        where: { id: id }, include: userIncludes
    });
    const user = await userTemp?.update(body);
    return [user];

}


export const deleteuser = async () => {


    const user = await User.update({

    }, { where: { 'available': 1 } });
    return user;

}