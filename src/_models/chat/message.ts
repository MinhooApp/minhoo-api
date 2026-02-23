import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

type ReactionMap = Record<string, number[]>; // { "❤️": [26, 10], "👍": [5] }

class Message extends Model {
  public id!: number;
  public chatId!: number;
  public senderId!: number;
  public text!: string | null;
  public messageType!:
    | "text"
    | "voice"
    | "image"
    | "video"
    | "document"
    | "contact";
  public mediaUrl!: string | null;
  public mediaMime!: string | null;
  public mediaDurationMs!: number | null;
  public mediaSizeBytes!: number | null;
  public waveform!: number[] | null;
  public metadata!: Record<string, any> | null;
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
      allowNull: true,
    },
    messageType: {
      type: DataTypes.ENUM(
        "text",
        "voice",
        "image",
        "video",
        "document",
        "contact"
      ),
      allowNull: false,
      defaultValue: "text",
    },
    mediaUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    mediaMime: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    mediaDurationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    mediaSizeBytes: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    waveform: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
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
