import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class CommentReport extends Model {
  [x: string]: any;
}

CommentReport.init(
  {
    commentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'commentId' can't be null" },
        notEmpty: { msg: "The field 'commentId' can't be empty" },
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
    modelName: "comment_report",
    tableName: "comment_reports",
  }
);

export default CommentReport;
