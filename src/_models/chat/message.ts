import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Message extends Model {
    [x: string
    ]: any;
}


Message.init(
    {
        chatId: {
            type: DataTypes.INTEGER,
            allowNull: false,

        },
        senderId: {
            type: DataTypes.INTEGER,
            allowNull: false,

        },
        text: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        date: {
            type: DataTypes.DATE,
            allowNull: false,
        },
        deletedBy: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        modelName: 'Message',
    }
);

export default Message;