import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ReelView extends Model {
  [x: string]: any;
}

ReelView.init(
  {
    reelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    session_key: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    viewed_date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "reel_view",
    tableName: "reel_views",
    indexes: [
      {
        unique: true,
        name: "uniq_reel_view_user_day",
        fields: ["reelId", "userId", "viewed_date"],
      },
      {
        unique: true,
        name: "uniq_reel_view_session_day",
        fields: ["reelId", "session_key", "viewed_date"],
      },
      {
        name: "idx_reel_views_reel_day",
        fields: ["reelId", "viewed_date"],
      },
    ],
  }
);

export default ReelView;
