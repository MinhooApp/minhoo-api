import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class StatusService extends Model {
    [x: string
    ]: any;
}
StatusService.init(
    {
        status: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'status' can't be null",
                },
                notEmpty: {
                    msg: "The field 'status' can't be empty",
                },
            },
        },
        description: {
            type: DataTypes.STRING,
            allowNull: true,

        },
    },
    {
        sequelize, modelName: 'statusService', tableName: 'statusService'
    },

);
StatusService.afterSync(async () => {
    await StatusService.findOrCreate({
        where: { id: 1, status: "Initialized", description: "Initialized Service" },
    });
    await StatusService.findOrCreate({
        where: { id: 2, status: "Assigned", description: "Assigned Service" },
    });
    await StatusService.findOrCreate({
        where: { id: 3, status: "In progress", description: "In Progress Service" },
    });
    await StatusService.findOrCreate({
        where: { id: 4, status: "Completed", description: "Completed Service" },
    });
    await StatusService.findOrCreate({
        where: { id: 5, status: "Canceled", description: "Canceled Service" },
    });
});
export default StatusService;
