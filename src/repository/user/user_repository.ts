import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import Plan from '../../_models/plan/plan';
import Category from '../../_models/category/category';
import generarJWT from '../../libs/helper/generate_jwt';
const excludeKeys = ["createdAt", "updatedAt", "password"];

const userIncludes = [{
    model: Role,
    as: "roles",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
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
export const add = async (body: any) => {
    const user = await User.create(body);
    await user.addRole(body.roles);
    await user.addCategory(body.categories);
    const result = await User.findOne({
        where: { email: body.email }, include: userIncludes,
    })
    return result;
}

export const gets = async () => {
    const user = await User.findAll({
        where: { available: true }, include: userIncludes,
    });
    return user;
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


export const findByEmail = async (email: String) => {
    const user = await User.findOne({
        where: { email: email }, include: userIncludes,
    });
    return user;
}

export const saveToken = async (id: any, roles: number[]) => {
    ///Genero el token
    const token = await generarJWT({ id: id, roles: roles });

    const body = { auth_token: token };
    const userTemp = await User.findOne({
        where: {
            id: id,
            available: true,
        },
        include: userIncludes
    });
    await userTemp?.update(body);

    const user = await User.findOne({
        where: { id: id, available: true },
        include: userIncludes,
        attributes: {
            exclude: excludeKeys,
        },
    });
    return user;
};
export const deleteuser = async () => {


    const user = await User.update({

    }, { where: { 'available': 1 } });
    return user;

}