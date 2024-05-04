import User from '../../_models/user/user';
import Comment from '../../_models/comment/comment';
import MediaPost from '../../_models/post/media_post'
import Category from '../../_models/category/category';
const excludeKeys = ["createdAt", "updatedAt", "password"];
const galeryInclude = [{
    model: Category,
    as: "categories",
    attributes: { exclude: excludeKeys },
    through: { attributes: [] },
}];
const userInclude = {
    model: User,
    as: "user",
    include: galeryInclude,
    attributes: ["name",
        "last_name",
        "email",
        "image_profil",
        "verified",
        "available",],

};
const userCommentInclude = {
    model: User,
    as: "user",
    attributes: ["name",
        "last_name",
        "email",
        "image_profil",
        "verified",
        "available",]
}
export const postInclude = [
    userInclude,
    {
        model: Comment,
        as: "comments",
        include: [userCommentInclude],


    }, {
        model: MediaPost,
        as: "post_media",
        attributes: ["url", "is_img"

        ]
    }
];