import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class User extends Model {
    [x: string
    ]: any;
}
User.init(
    {

        name: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'name' can't be null",
                },
                notEmpty: {
                    msg: "The field 'name' can't be empty",
                },
            },
        },
        last_name: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'last_name' can't be null",
                },
                notEmpty: {
                    msg: "The field 'last_name' can't be empty",
                },
            },
        },
        email: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
            validate: {
                notNull: {
                    msg: "The field 'email' can't be null",
                },
                notEmpty: {
                    msg: "The field 'email' can't be empty",
                },
            },
        },

        password: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'password' can't be null",
                },
                notEmpty: {
                    msg: "The field 'password' can't be empty",
                },
            },
        },
        temp_password: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        auth_token: {
            type: DataTypes.TEXT,
            allowNull: true,

        },
        imageProfil: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        is_available: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true
        },


    },
    {
        sequelize, modelName: 'user'
    }
);
export default User;
