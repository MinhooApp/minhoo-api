import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Offer extends Model {
    [x: string
    ]: any;
}
Offer.init(
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
        offer: {
            type: DataTypes.DOUBLE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'offer' can't be null",
                },
                notEmpty: {
                    msg: "The field 'offer' can't be empty",
                },
            },
        },
        accepted: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,

        },
    },
    {
        sequelize, modelName: 'offer'
    }
);
export default Offer;
