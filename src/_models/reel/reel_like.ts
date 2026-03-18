import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ReelLike extends Model {
  [x: string]: any;
}

ReelLike.init(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    reelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "reel_like",
    tableName: "reel_likes",
    indexes: [
      {
        unique: true,
        name: "uniq_reel_like_user",
        fields: ["userId", "reelId"],
      },
      {
        name: "idx_reel_likes_reel",
        fields: ["reelId", "createdAt"],
      },
    ],
  }
);

export default ReelLike;
