import User from '../../_models/user/user';
import Service from '../../_models/service/service';
import Category from '../../_models/category/category';
const excludeKeys = ["createdAt", "updatedAt", "password"];


const serviceInclude = [{
    model: User,
    as: "user",
    attributes: { exclude: excludeKeys },
},
{

    model: Category,
    as: "category",
    attributes: { exclude: excludeKeys },



}


];
export const add = async (body: any) => {
    const service = await Service.create(body);
    const response = await Service.findByPk(service.id,

        { include: serviceInclude, attributes: { exclude: excludeKeys }, },

    )
    return response;
}

export const gets = async () => {
    const service = await Service.findAll({ where: { is_available: true } });
    return service;
}
export const get = async (id: any) => {
    const service = await Service.findOne({ where: { id: id } });
    return service;
}

export const update = async (id: any, body: any) => {
    const serviceTemp = await Service.findByPk(id);
    const service = await serviceTemp?.update(body);
    return [service];

}

export const deleteservice = async () => {


    const service = await Service.update({

    }, { where: { 'is_delete': 1 } });
    return service;

}