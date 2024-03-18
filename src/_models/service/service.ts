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
            type: DataTypes.STRING,
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
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'longitude' can't be null",
                },
                notEmpty: {
                    msg: "The field 'longitude' can't be empty",
                },
            },
        },
        latitude: {
            type: DataTypes.DOUBLE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'latitude' can't be null",
                },
                notEmpty: {
                    msg: "The field 'latitude' can't be empty",
                },
            },
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
