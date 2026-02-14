import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

type ReactionMap = Record<string, number[]>; // { "❤️": [26, 10], "👍": [5] }

class Message extends Model {
  public id!: number;
  public chatId!: number;
  public senderId!: number;
  public text!: string;
  public date!: Date;
  public deletedBy!: number;

  // status
  public status!: "sent" | "delivered" | "read";
  public deliveredAt!: Date | null;
  public readAt!: Date | null;

  // ✅ REPLY (WhatsApp-like)
  public replyToMessageId!: number | null;

  // ✅ REACTIONS (emoji -> [userIds])
  public reactions!: ReactionMap; // JSON column
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

    status: {
      type: DataTypes.ENUM("sent", "delivered", "read"),
      allowNull: false,
      defaultValue: "sent",
    },
    deliveredAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // ✅ REPLY
    replyToMessageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    // ✅ REACTIONS
    reactions: {
      // En MySQL 8: JSON ✅
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {}, // importante para que no venga null
    },
  },
  {
    sequelize,
    modelName: "Message",
    tableName: "messages",
  }
);

// ✅ SELF ASSOCIATION (reply)
Message.belongsTo(Message, {
  foreignKey: "replyToMessageId",
  as: "replyTo",
});

export default Message;
