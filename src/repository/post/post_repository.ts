import User from '../../_models/user/user';
import Post from '../../_models/post/post';
import { postInclude } from './post_include';
import Comment from '../../_models/comment/comment';
import MediaPost from '../../_models/post/media_post'
import Category from '../../_models/category/category';
const excludeKeys = ["createdAt", "updatedAt", "password"];


export const add = async (body: any) => {
    const post: any = await Post.create(body);

    if (body.media_url != null) {
        // Crea una instancia de MediaPost para cada cadena de texto en el array
        const mediaPosts = await Promise.all(body.media_url.map(async (str: any) => {
            const mediaPost = await MediaPost.create({
                postId: post.id, // Asigna el postId al id del post creado
                url: str, // Asigna la cadena de texto como URL
                is_img: true // Opcional: ajusta el valor de is_img según sea necesario
            });
            return mediaPost;
        }));
    }

    return post
}
export const all = async () => {
    const post = await Post.findAll({
        include: postInclude
    });
    return post;
}
export const gets = async (page: any = 0, size: any = 10) => {
    let option = {
        limit: +size,
        offset: (+page) * (+size)
    }
    const post = await Post.findAndCountAll(

        {
            where: { is_delete: false },
            ...option,
            include: postInclude,
            order: [["created_date", "DESC"]]

        }

    );
    return post;
}

export const getOne = async (id: any) => {
    const comment = await Post.findOne({
        where: { id: id }, include: [
            {
                model: User,
                as: "user",
                attributes: ["name",
                    "last_name",
                    "email",
                    "image_profil",
                    "available",]
            },
            {
                model: Comment,
                as: "comments",
                include: [{
                    model: User,
                    as: "user",
                    attributes: ["name",
                        "last_name",
                        "email",
                        "image_profil",
                        "available",]
                },]

            }
        ]
    });
    return comment;
}
export const get = async (id: any) => {
    const post = await Post.findOne({
        where: { id: id, is_delete: false }, include: postInclude
    });
    return post;
}

export const update = async (id: any, body: any) => {
    const postTemp = await Post.findByPk(id, {
        include: postInclude
    });
    const post = await postTemp?.update(body);
    return [post];

}

export const deletepost = async () => {


    const post = await Post.update({

    }, { where: { 'is_delete': 1 } });
    return post;

}