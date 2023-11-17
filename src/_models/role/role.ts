import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Role extends Model {
    [x: string
    ]: any;
}
Role.init(
    {
        role: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
            validate: {
                notNull: {
                    msg: "The field 'role' can't be null",
                },
                notEmpty: {
                    msg: "The field 'role' can't be empty",
                },
            },
        },
        description: {
            type: DataTypes.STRING,
            allowNull: true,
        },
    },
    {
        sequelize, modelName: 'role'
    }
);
Role.afterSync(async () => {
    await Role.findOrCreate({
        where: { id: 1, role: "client", description: "client role" },
    });
    await Role.findOrCreate({
        where: { id: 2, role: "agent", description: "agent role" },
    });
    await Role.findOrCreate({
        where: { id: 8088, role: "admin", description: "admin role" },
    });
});

export default Role;
