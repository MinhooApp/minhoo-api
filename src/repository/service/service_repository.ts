
import { Op } from 'sequelize';
import Service from '../../_models/service/service';
import { serviceInclude } from './service_includes';
import Service_Worker from '../../_models/service/service_worker';
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


export const history = async (userId?: number) => {
    if (userId != undefined) {

        const service = await Service.findAll({
            where: {
                userId: userId,


                [Op.not]: [
                    {
                        statusId: 1
                    }
                ]

            }, include: serviceInclude
        });
        return service;
    } else {
        const service = await Service.findAll({

            where: {

                [Op.not]: [
                    {
                        statusId: 1
                    }
                ]
            },

        });
        return service;
    }
}
export const onGoing = async (userId?: number) => {
    if (userId) {
        const service = await Service.findAll({
            where: {

                is_available: true,
                statusId: 1,
                userId: userId

            },


            include: serviceInclude, order: [['service_date', 'DESC']]
        });
        return service;
    } else {
        const service = await Service.findAll({ where: { is_available: true, statusId: 1 }, include: serviceInclude, order: [['service_date', 'DESC']] });
        return service;
    }
}

export const get = async (id: any) => {
    const service = await Service.findOne({ where: { id: id }, include: serviceInclude });
    return service;
}

export const update = async (id: any, body: any) => {
    const serviceTemp = await Service.findByPk(id,);
    const service = await serviceTemp?.update(body);
    return [service];

}//
export const assignWorker = async (workerId: any, request: Service, assigend: boolean) => {
    // const serviceTemp = await Service.findByPk(id,);

    await request.addWorker(workerId, { through: { removed: false } });
    if (assigend) {
        await request.update({ statusId: 2 });
    }
    const service = await Service_Worker.findOne({ where: { serviceId: request.id, workerId: workerId } })
    return service;

}
export const removeWorker = async (serviceId: any, workerId: any) => {
    // const serviceTemp = await Service.findByPk(id,);
    const temp = await Service_Worker.findOne({ where: { serviceId: serviceId, workerId: workerId } })
    const worker = temp?.update({ removed: true })

    return worker;

}

export const deleteservice = async () => {


    const service = await Service.update({

    }, { where: { 'is_delete': 1 } });
    return service;

}