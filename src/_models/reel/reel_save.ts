import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ReelSave extends Model {
  [x: string]: any;
}

ReelSave.init(
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
    modelName: "reel_save",
    tableName: "reel_saves",
    indexes: [
      {
        unique: true,
        name: "uniq_reel_save_user",
        fields: ["userId", "reelId"],
      },
      {
        name: "idx_reel_saves_user_created",
        fields: ["userId", "createdAt"],
      },
    ],
  }
);

export default ReelSave;
