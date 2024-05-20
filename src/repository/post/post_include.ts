import User from '../../_models/user/user';
import { Includeable } from 'sequelize';
import Comment from '../../_models/comment/comment';
import MediaPost from '../../_models/post/media_post'
import Category from '../../_models/category/category';
import { followIncludes } from "../follower/follower_include";
import { userIncludes } from '../user/user_include';
const excludeKeys = ["createdAt", "updatedAt", "password"];
const galeryInclude: Includeable[] = [{
    model: Category,
    as: "categories",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
}];
const userInclude: Includeable = {
    model: User,
    as: "user",
    include: [
        ...followIncludes,
        ...galeryInclude,
        ...userIncludes

    ],
    attributes: [
        "id",
        "name",
        "last_name",
        "email",
        "image_profil",
        "verified",
        "available",],


    //

};

export const postInclude: Includeable[] = [

    userInclude,
    {
        model: MediaPost,
        as: "post_media",
        attributes: ["url", "is_img",


        ],
        required: false
    },

    {
        model: Comment,
        as: "comments",
        attributes: ["id", "userId", "comment", "media_url"],
        where: { "is_delete": false },
        required: false,

        include: [
            {
                model: User, as: "commentator",
                attributes: ["id", "name", "last_name", "image_profil"],
                required: false

            }
        ]

    },



];