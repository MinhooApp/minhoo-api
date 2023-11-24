import Post from '../../_models/post/post';
export const add = async (body: any) => {
    const post = await Post.create(body);
    return post;
}

export const gets = async () => {
    const post = await Post.findAll({ where: { is_available: true } });
    return post;
}
export const get = async (id: any) => {
    const post = await Post.findAll({ where: { id: id } });
    return post;
}

export const update = async (id: any, body: any) => {
    const postTemp = await Post.findByPk(id);
    const post = await postTemp?.update(body);
    return [post];

}

export const deletepost = async () => {


    const post = await Post.update({

    }, { where: { 'is_delete': 1 } });
    return post;

}