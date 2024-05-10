import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Service extends Model {
    [x: string
    ]: any;
}
Service.init(
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



        description: {
            type: DataTypes.TEXT,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'description' can't be null",
                },
                notEmpty: {
                    msg: "The field 'description' can't be empty",
                },
            },
        },
        rate: {
            type: DataTypes.DOUBLE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'rate' can't be null",
                },
                notEmpty: {
                    msg: "The field 'rate' can't be empty",
                },
            },
        },
        service_date: {
            type: DataTypes.DATE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'service_date' can't be null",
                },
                notEmpty: {
                    msg: "The field 'service_date' can't be empty",
                },
            },
        },
        longitude: {
            type: DataTypes.DOUBLE,
            allowNull: true,

        },
        latitude: {
            type: DataTypes.DOUBLE,
            allowNull: true,

        },
        address: {
            type: DataTypes.TEXT,
            allowNull: true,

        },
        net_pay: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'net_ay' can't be null",
                },
                notEmpty: {
                    msg: "The field 'net_ay' can't be empty",
                },

            },
            defaultValue: true
        },
        is_available: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,

        },

    },
    {
        sequelize, modelName: 'service'
    }
);
export default Service;
