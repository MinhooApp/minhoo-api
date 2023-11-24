import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import generarJWT from '../../libs/helper/generate_jwt';
import Plan from '../../_models/plan/plan';
const excludeKeys = ["createdAt", "updatedAt", "password"];
export const add = async (body: any) => {
    const user = await User.create(body);
    await user.addRole(body.roles);
    const result = await User.findOne({
        where: { email: body.email }, include: [

            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },
            },
        ],
    })
    return result;
}

export const gets = async () => {
    const user = await User.findAll({
        where: { is_available: true }, include: [

            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },
            },
        ],
    });
    return user;
}
export const get = async (id: any) => {
    const user = await User.findOne({
        where: { id: id }, include: [

            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },
            },
        ],
    });
    return user;
}

export const update = async (id: any, body: any) => {
    const userTemp = await User.findOne({
        where: { id: id }, include: [{
            model: Role,
            as: "roles",
            attributes: { exclude: excludeKeys },
            through: { attributes: [] },
        },
        {
            model: Plan,
            as: "plan",
            attributes: { exclude: excludeKeys },
        },
        ]
    });
    const user = await userTemp?.update(body);
    return [user];

}


export const findByEmail = async (email: String) => {
    const user = await User.findOne({
        where: { email: email }, include: [

            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },
            },
        ],
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
            is_available: true,
        },
        include: [{
            model: Role,
            as: "roles",
            attributes: { exclude: excludeKeys },
            through: { attributes: [] },
        },
        {
            model: Plan,
            as: "plan",
            attributes: { exclude: excludeKeys },
        },




        ],
    });
    await userTemp?.update(body);

    const user = await User.findOne({
        where: { id: id, is_available: true },
        include: [

            {
                model: Role,
                as: "roles",
                attributes: { exclude: excludeKeys },
                through: { attributes: [] },
            },
            {
                model: Plan,
                as: "plan",
                attributes: { exclude: excludeKeys },

            },
        ],
        attributes: {
            exclude: excludeKeys,
        },
    });
    return user;
};
export const deleteuser = async () => {


    const user = await User.update({

    }, { where: { 'is_available': 1 } });
    return user;

}