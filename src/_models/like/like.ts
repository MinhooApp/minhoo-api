import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Like extends Model {
    [x: string
    ]: any;
}
Like.init(
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
        commentId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'commentId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'commentId' can't be empty",
                },
            },
        },

    },
    {
        sequelize, modelName: 'like'
    }
);
export default Like;
