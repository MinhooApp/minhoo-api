import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Service_Worker extends Model {
    [x: string
    ]: any;
}
Service_Worker.init(
    {
        serviceId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'serviceId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'serviceId' can't be empty",
                },
            },
        },
        workerId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'workerId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'workerId' can't be empty",
                },
            },
        },
        removed: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            validate: {
                notNull: {
                    msg: "The field 'removed' can't be null",
                },
                notEmpty: {
                    msg: "The field 'removed' can't be empty",
                },
            },
        },
    },
    {
        sequelize, modelName: 'service_worker'
    }
);
export default Service_Worker;
