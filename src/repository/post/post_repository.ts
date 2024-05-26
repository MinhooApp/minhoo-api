
import Post from '../../_models/post/post';
import Like from '../../_models/like/like';
import { postInclude } from './post_include';
import MediaPost from '../../_models/post/media_post'
const excludeKeys = ["createdAt", "updatedAt",];


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

            order: [["created_date", "DESC"]],
            attributes: { exclude: excludeKeys },

        }

    );

    return post;
}

export const getOne = async (id: any) => {
    const comment = await Post.findOne({
        where: { id: id },
        include: postInclude,
        attributes: { exclude: excludeKeys },

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
        include: postInclude,
        attributes: { exclude: excludeKeys },
    });
    const post = await postTemp?.update(body);
    return [post];

}

export const deletepost = async () => {


    const post = await Post.update({

    }, { where: { 'is_delete': 1 } });
    return post;

}
export const toggleLike = async (userId: any,
    postId: any,) => {
    // Buscar si ya existe una fila con los IDs proporcionados
    const existingFollow = await Like.findOne({
        where: {
            userId,
            postId,
        }
    });

    if (existingFollow) {
        // Si existe, eliminar la fila para dejar de gustar
        await existingFollow.destroy();
        return false; // Ya no le gusta al usuario
    } else {
        // Si no existe, crear una nueva fila para like
        await Like.create({
            userId,
            postId
        });
        return true; // like
    }

}