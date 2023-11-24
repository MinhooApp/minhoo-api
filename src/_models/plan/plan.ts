import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Plan extends Model {
    [x: string
    ]: any;
}
Plan.init(
    {
        plan: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'plan' can't be null",
                },
                notEmpty: {
                    msg: "The field 'plan' can't be empty",
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
        price: {
            type: DataTypes.DOUBLE,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'price' can't be null",
                },
                notEmpty: {
                    msg: "The field 'price' can't be empty",
                },
            },
        },

    },
    {
        sequelize, modelName: 'plan'
    }
);
Plan.afterSync(async () => {
    await Plan.findOrCreate({
        where: { id: 1, plan: "basic", description: "basic plan", price: 0 },
    });

});

export default Plan;
