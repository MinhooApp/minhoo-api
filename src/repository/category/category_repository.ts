import Category from '../../_models/category/category';
const excludeKeys = ["createdAt", "updatedAt", "password"];

export const add = async (body: any) => {
    const category = await Category.create(body);
    return category;
}

export const gets = async () => {
    const category = await Category.findAll({ where: { available: true }, attributes: { exclude: excludeKeys } });
    return category;
}
export const get = async (id: any) => {
    const category = await Category.findOne({ where: { id: id }, attributes: { exclude: excludeKeys } });
    return category;
}

export const update = async (id: any, body: any) => {
    const categoryTemp = await Category.findByPk(id, { attributes: { exclude: excludeKeys } });
    const category = await categoryTemp?.update(body);
    return [category];

}

export const deletecategory = async () => {


    const category = await Category.update({

    }, { where: { 'available': 1 } });
    return category;

}