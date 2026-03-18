import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Comment extends Model {
    [x: string
    ]: any;
}
Comment.init(
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
        comment: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'comment' can't be null",
                },
                notEmpty: {
                    msg: "The field 'comment' can't be empty",
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
        sequelize, modelName: 'comment'
    }
);
export default Comment;
