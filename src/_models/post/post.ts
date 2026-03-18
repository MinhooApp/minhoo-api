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
        categoryId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'categoryId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'categoryId' can't be empty",
                },
            },
        },
        post: {
            type: DataTypes.TEXT,
            allowNull: false,
            defaultValue: "",
            validate: {
                notNull: {
                    msg: "The field 'post' can't be null",
                },
            },
        },
        likes_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        saves_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
        shares_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
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
        created_date: {
            type: DataTypes.DATE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'created_date' can't be null",
                },
                notEmpty: {
                    msg: "The field 'created_date' can't be empty",
                },
            },
        },
        deleted_date: {
            type: DataTypes.DATE,
            allowNull: true,

        },
    },
    {
        sequelize, modelName: 'post'
    }
);
export default Post;
