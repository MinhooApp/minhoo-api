
import Service from '../../_models/service/service';
import { serviceInclude } from './service_includes';
const excludeKeys = ["createdAt", "updatedAt", "password"];



export const add = async (body: any) => {
    const service = await Service.create(body);
    const response = await Service.findByPk(service.id,

        { include: serviceInclude, attributes: { exclude: excludeKeys }, },

    )
    return response;
}

export const gets = async () => {
    const service = await Service.findAll({ where: { is_available: true }, include: serviceInclude });
    return service;
}


export const onGoing = async (userId: String) => {
    const service = await Service.findAll({ where: { is_available: true, userId: userId }, include: serviceInclude });
    return service;
}
export const get = async (id: any) => {
    const service = await Service.findOne({ where: { id: id }, include: serviceInclude });
    return service;
}

export const update = async (id: any, body: any) => {
    const serviceTemp = await Service.findByPk(id,);
    const service = await serviceTemp?.update(body);
    return [service];

}

export const deleteservice = async () => {


    const service = await Service.update({

    }, { where: { 'is_delete': 1 } });
    return service;

}