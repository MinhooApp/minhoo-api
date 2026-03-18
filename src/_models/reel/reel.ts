import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Reel extends Model {
  [x: string]: any;
}

Reel.init(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    video_uid: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    stream_url: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    download_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    thumbnail_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    duration_seconds: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    visibility: {
      type: DataTypes.ENUM("public", "followers", "private"),
      allowNull: false,
      defaultValue: "public",
    },
    status: {
      type: DataTypes.ENUM("processing", "ready", "failed"),
      allowNull: false,
      defaultValue: "ready",
    },
    allow_download: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    views_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    likes_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    comments_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    shares_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    saves_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    modelName: "reel",
    tableName: "reels",
    indexes: [
      { name: "idx_reels_user_created", fields: ["userId", "createdAt"] },
      { name: "idx_reels_visibility_created", fields: ["visibility", "createdAt"] },
      { name: "idx_reels_video_uid", fields: ["video_uid"] },
    ],
  }
);

export default Reel;
