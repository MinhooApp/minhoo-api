import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class MediaWorker extends Model {
    [x: string
    ]: any;
}
MediaWorker.init(
    {
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
        url: {
            type: DataTypes.STRING,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'url' can't be null",
                },
                notEmpty: {
                    msg: "The field 'url' can't be empty",
                },
            },
        },
        is_img: {
            type: DataTypes.BOOLEAN,
            allowNull: true,
            defaultValue: true

        },
    },
    {
        sequelize, modelName: 'mediaWorker',
        tableName: "mediaworker"
    }
);
export default MediaWorker;
