import {
    DataTypes, Model
} from 'sequelize';
import sequelize from '../../_db/connection';

class Chat extends Model {
    [x: string
    ]: any;
}

Chat.init(
    {
        deletedBy: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
        },
    },
    {
        sequelize,
        modelName: 'Chat',
    }
);

export default Chat