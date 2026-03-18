import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ReelReport extends Model {
  [x: string]: any;
}

ReelReport.init(
  {
    reelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'reelId' can't be null" },
        notEmpty: { msg: "The field 'reelId' can't be empty" },
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
    modelName: "reel_report",
    tableName: "reel_reports",
  }
);

export default ReelReport;
