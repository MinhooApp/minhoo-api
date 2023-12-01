import Like from '../../_models/like/like';
export const add = async (body: any) => {
    const like = await Like.create(body);
    return like;
}

export const gets = async () => {
    const like = await Like.findAll({ where: { is_available: true } });
    return like;
}
export const get = async (id: any) => {
    const like = await Like.findOne({ where: { id: id } });
    return like;
}

export const update = async (id: any, body: any) => {
    const likeTemp = await Like.findByPk(id);
    const like = await likeTemp?.update(body);
    return [like];

}

export const deletelike = async () => {


    const like = await Like.update({

    }, { where: { 'is_delete': 1 } });
    return like;

}