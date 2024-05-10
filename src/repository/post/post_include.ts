import User from '../../_models/user/user';
import Comment from '../../_models/comment/comment';
import MediaPost from '../../_models/post/media_post'
import Category from '../../_models/category/category';
import { followIncludes } from "../follower/follower_include";
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
    include: [
        ...followIncludes,
        ...galeryInclude],
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
const userCommentInclude = {
    model: User,
    as: "user",
    attributes: [
        "id",
        "name",
        "last_name",
        "email",
        "image_profil",
        "verified",
        "available",]
}
export const postInclude = [
    userInclude,
    {
        model: MediaPost,
        as: "post_media",
        attributes: ["url", "is_img"

        ]
    }
];