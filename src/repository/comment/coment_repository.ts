import Comment from '../../_models/comment/comment';
export const add = async (body: any) => {
    const comment = await Comment.create(body);
    return comment;
}

export const all = async () => {
    const comment = await Comment.findAll();
    return comment;
}
export const gets = async () => {
    const comment = await Comment.findAll({ where: { is_delete: false } });
    return comment;
}
export const getOne = async (id: any) => {
    const comment = await Comment.findOne({ where: { id: id } });
    return comment;
}
export const get = async (id: any) => {
    const comment = await Comment.findOne({ where: { id: id, is_delete: false } });
    return comment;
}

export const update = async (id: any, body: any) => {
    const commentTemp = await Comment.findByPk(id);
    const comment = await commentTemp?.update(body);
    return [comment];

}

export const deletecomment = async (id: any) => {


    const comment = await Comment.update({
        'is_delete': true

    }, { where: { id: id } });
    return comment;

}