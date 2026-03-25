import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ChatReport extends Model {
  [x: string]: any;
}

ChatReport.init(
  {
    chatId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'chatId' can't be null" },
        notEmpty: { msg: "The field 'chatId' can't be empty" },
      },
    },
    messageId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    reporterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'reporterId' can't be null" },
        notEmpty: { msg: "The field 'reporterId' can't be empty" },
      },
    },
    reason: {
      type: DataTypes.STRING(120),
      allowNull: false,
      defaultValue: "something_else",
    },
    details: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "chat_report",
    tableName: "chat_reports",
  }
);

export default ChatReport;
