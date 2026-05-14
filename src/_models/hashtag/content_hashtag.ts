import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ContentHashtag extends Model {
  [x: string]: any;
}

ContentHashtag.init(
  {
    hashtagId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    content_type: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    content_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    modelName: "content_hashtag",
    tableName: "content_hashtags",
    indexes: [
      {
        name: "uq_content_hashtags_content_tag",
        unique: true,
        fields: ["content_type", "content_id", "hashtagId"],
      },
      {
        name: "idx_content_hashtags_tag_created",
        fields: ["hashtagId", "createdAt", "id"],
      },
      {
        name: "idx_content_hashtags_content_lookup",
        fields: ["content_type", "content_id"],
      },
    ],
  }
);

export default ContentHashtag;
