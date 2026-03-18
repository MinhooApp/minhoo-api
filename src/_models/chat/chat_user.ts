
import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Chat_User extends Model {
    [x: string
    ]: any;
}
Chat_User.init(
    {
        userId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            primaryKey: true,
        },
        chatId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            primaryKey: true,
        },
        pinnedAt: {
            type: DataTypes.DATE,
            allowNull: true,
        },
        pinnedOrder: {
            type: DataTypes.INTEGER,
            allowNull: true,
        },
        lastReadMessageId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },

    },
    {
        sequelize,
        modelName: 'chat_user',
        tableName: "chat_user"

    }
);

export default Chat_User;
