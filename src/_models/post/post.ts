import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Post extends Model {
    [x: string
    ]: any;
}
Post.init(
    {
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'userId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'userId' can't be empty",
                },
            },
        },
        post: {
            type: DataTypes.TEXT,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'post' can't be null",
                },
                notEmpty: {
                    msg: "The field 'post' can't be empty",
                },
            },
        },
        media_url: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        is_delete: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            validate: {
                notNull: {
                    msg: "The field 'is_delete' can't be null",
                },
                notEmpty: {
                    msg: "The field 'is_delete' can't be empty",
                },
            },
        },
    },
    {
        sequelize, modelName: 'post'
    }
);
export default Post;
