import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Follower extends Model {
    [x: string
    ]: any;
}
Follower.init(
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
        followerId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            validate: {
                notNull: {
                    msg: "The field 'followerId' can't be null",
                },
                notEmpty: {
                    msg: "The field 'followerId' can't be empty",
                },
            },
        },
    },
    {
        sequelize,
        modelName: 'follower',
        indexes: [
            {
                unique: true,
                fields: ['userId', 'followerId'],
                name: 'uniq_follow_user_follower'
            }
        ]
    }
);
export default Follower;
