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
        countryId: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        cityId: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        planId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 1,
            validate: {
                notNull: {
                    msg: "The field 'planId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'planId' can't be empty",
                },
            },
        },
        dni: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        name: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        last_name: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        birthday: {
            type: DataTypes.DATE,
            allowNull: true,

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
        dialing_code: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        iso_code: {
            type: DataTypes.STRING,
            allowNull: true
        },
        phone: {
            type: DataTypes.STRING,
            unique: true,
            allowNull: true
        },
        language: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        uuid: {
            type: DataTypes.STRING,
            allowNull: true,

        },

        auth_token: {
            type: DataTypes.TEXT,
            allowNull: true,

        },
        image_profil: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: "\\uploads\\images\\user\\profil\\profil.png",
            validate: {
                notNull: {
                    msg: "The field 'image_profil' can't be null",
                },
                notEmpty: {
                    msg: "The field 'image_profil' can't be empty",
                },
            },

        },
        about: {
            type: DataTypes.TEXT,
            allowNull: true,

        },
        last_longitude: {
            type: DataTypes.DECIMAL,
            allowNull: true,

        },
        last_latitude: {
            type: DataTypes.DECIMAL,
            allowNull: true,

        },
        password: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        temp_password: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        verified: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
        },
        available: {
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
