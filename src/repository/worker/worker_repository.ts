


import Worker from '../../_models/worker/worker';
import { workerIncludes } from './worker_includes';
const excludeKeys = ["createdAt", "updatedAt", "password"];






export const add = async (body: any) => {
    const worker = await Worker.create(body);
    return worker;
}
export const gets = async () => {
    const worker = await Worker.findAll({
        where: { available: true }, include: workerIncludes,
    });
    return worker;
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
            include: workerIncludes,
            attributes: { exclude: excludeKeys },

        }

    );
    return workers;
}

export const update = async (id: any, body: any) => {
    const workerTemp = await Worker.findOne({
        where: { id: id }, include: workerIncludes
    });


    const worker = await workerTemp?.update(body);
    // Obtener las categorías actuales del trabajador
    const currentCategories = await worker?.getCategories();
    // Eliminar las categorías actuales del trabajador
    await worker?.removeCategories(currentCategories);
    // Asociar las nuevas categorías al trabajador
    await worker?.addCategories(body.categories);
    return worker;

}

export const worker = async (id: any) => {

    const worker = await Worker.findOne(
        {
            where: { userId: id, available: 1 },

            include: workerIncludes,
            attributes: { exclude: excludeKeys },

        }

    );
    return worker;
}
