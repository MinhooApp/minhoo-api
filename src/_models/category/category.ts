import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Category extends Model {
    [x: string
    ]: any;
}
Category.init(
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
        es_name: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'es_name' can't be null",
                },
                notEmpty: {
                    msg: "The field 'es_name' can't be empty",
                },
            },
        },
        available: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: true,
            validate: {
                notNull: {
                    msg: "The field 'available' can't be null",
                },
                notEmpty: {
                    msg: "The field 'available' can't be empty",
                },
            },
        },
    },
    {
        sequelize, modelName: 'category'
    }
);
Category.afterSync(async () => {
    await Category.findOrCreate({
        where: { id: 1, name: "Branding", es_name: "Branding" },
    });
    await Category.findOrCreate({
        where: { id: 2, name: "Design", es_name: "Diseño" },
    });
    await Category.findOrCreate({
        where: { id: 3, name: "Creative", es_name: "Creativo" },
    });
});
export default Category;
