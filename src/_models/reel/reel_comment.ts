import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ReelComment extends Model {
  [x: string]: any;
}

ReelComment.init(
  {
    reelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    media_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    is_delete: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    deleted_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "reel_comment",
    tableName: "reel_comments",
    indexes: [
      {
        name: "idx_reel_comments_reel_created",
        fields: ["reelId", "createdAt"],
      },
      {
        name: "idx_reel_comments_user_created",
        fields: ["userId", "createdAt"],
      },
    ],
  }
);

export default ReelComment;
