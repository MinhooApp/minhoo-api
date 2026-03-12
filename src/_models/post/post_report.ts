import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class PostReport extends Model {
  [x: string]: any;
}

PostReport.init(
  {
    postId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'postId' can't be null" },
        notEmpty: { msg: "The field 'postId' can't be empty" },
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
    modelName: "post_report",
    tableName: "post_reports",
  }
);

export default PostReport;
