
import { Includeable } from 'sequelize';
import User from '../../_models/user/user';
import Role from '../../_models/role/role';
import Plan from '../../_models/plan/plan';
import Worker from '../../_models/worker/worker';
import Category from '../../_models/category/category';
import MediaWorker from '../../_models/worker/media_worker';


const excludeKeys = ["createdAt", "updatedAt", "password"];

const includes: Includeable[] = [
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
    },
    {
        model: MediaWorker,
        as: "worker_media",
        attributes: { exclude: excludeKeys },
    }
]

export const add = async (body: any) => {
    const worker = await Worker.create(body);
    return worker;
}
export const gets = async () => {
    const worker = await Worker.findAll({
        where: { available: true }, include: includes,
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
            include: includes,
            attributes: { exclude: excludeKeys },

        }

    );
    return workers;
}

export const update = async (id: any, body: any) => {
    const workerTemp = await Worker.findOne({
        where: { id: id }, include: includes
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

            include: includes,
            attributes: { exclude: excludeKeys },

        }

    );
    return worker;
}
