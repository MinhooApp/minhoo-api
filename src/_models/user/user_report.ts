import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class UserReport extends Model {
  [x: string]: any;
}

UserReport.init(
  {
    reportedUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'reportedUserId' can't be null" },
        notEmpty: { msg: "The field 'reportedUserId' can't be empty" },
      },
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
    modelName: "user_report",
    tableName: "user_reports",
  }
);

export default UserReport;
