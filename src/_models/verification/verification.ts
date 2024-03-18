import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Verification extends Model {
    [x: string
    ]: any;
}
Verification.init(
    {
        code: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'code' can't be null",
                },
                notEmpty: {
                    msg: "The field 'code' can't be empty",
                },
            },
        },
        email: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        phone: {
            type: DataTypes.STRING,
            allowNull: true,

        },
        verified: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false

        },
        created: {
            type: DataTypes.DATE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'created' can't be null",
                },
                notEmpty: {
                    msg: "The field 'created' can't be empty",
                },
            },
        },
    },
    {
        sequelize, modelName: 'verification'
    }
);
export default Verification;
