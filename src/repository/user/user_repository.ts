import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import Plan from '../../_models/plan/plan';
import Category from '../../_models/category/category';
import Worker from '../../_models/worker/worker';
import generarJWT from '../../libs/helper/generate_jwt';
import { userIncludes } from './user_include';
const excludeKeys = ["createdAt", "updatedAt", "password"];


const includes = userIncludes



export const gets = async () => {
    const user = await User.findAll({
        where: { available: true }, include: includes,
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
            include: includes

        }

    );
    return users;
}

export const get = async (id: any) => {
    const user = await User.findOne({
        where: { id: id }, include: includes,
    });
    return user;
}

export const update = async (id: any, body: any) => {
    const userTemp = await User.findOne({
        where: { id: id }, include: includes
    });
    const user = await userTemp?.update(body);
    return [user];

}


export const deleteuser = async () => {


    const user = await User.update({

    }, { where: { 'available': 1 } });
    return user;

}