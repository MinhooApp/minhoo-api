import User from '../../_models/user/user';
import Post from '../../_models/post/post';
import { userIncludes } from './user_include';
import MediaPost from '../../_models/post/media_post';
const excludeKeys = ["createdAt", "updatedAt", "password"];


const includes = userIncludes



export const gets = async () => {
    const user = await User.findAll({
        where: { available: true }, include: includes,
    });
    return user;
}

export const users = async (page: any = 0, size: any = 10) => {
    let option = {
        limit: +size,
        offset: (+page) * (+size)
    }
    const users = await User.findAndCountAll(
        {
            where: { available: 1 },
            ...option,
            include: includes

        }

    );
    return users;
}

export const get = async (id: any) => {
    const user = await User.findOne({
        where: { id: id }, include: [...includes, {
            model: Post,
            as: "posts",
            include: [

                {
                    model: MediaPost,
                    as: "post_media",
                    attributes: ["url", "is_img"

                    ]
                }
            ]
        }],
    });
    return user;
}

export const update = async (id: any, body: any) => {
    const userTemp = await User.findOne({
        where: { id: id }, include: includes
    });
    const user = await userTemp?.update(body);
    return [user];

}


export const deleteuser = async () => {


    const user = await User.update({

    }, { where: { 'available': 1 } });
    return user;

}