import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class MediaPost extends Model {
    [x: string
    ]: any;
}
MediaPost.init(
    {
        postId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'postId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'postId' can't be empty",
                },
            },
        },
        url: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'url' can't be null",
                },
                notEmpty: {
                    msg: "The field 'url' can't be empty",
                },
            },
        },
        is_img: {
            type: DataTypes.BOOLEAN,
            allowNull: true,

        },
    },
    {
        sequelize, modelName: 'mediaPost'
    }
);
export default MediaPost;
