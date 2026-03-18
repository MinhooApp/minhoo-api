import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class SavedPost extends Model {
  [x: string]: any;
}

SavedPost.init(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'userId' can't be null",
        },
        notEmpty: {
          msg: "The field 'userId' can't be empty",
        },
      },
    },
    postId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'postId' can't be null",
        },
        notEmpty: {
          msg: "The field 'postId' can't be empty",
        },
      },
    },
  },
  {
    sequelize,
    modelName: "saved_post",
    tableName: "saved_posts",
    indexes: [
      {
        unique: true,
        fields: ["userId", "postId"],
        name: "uniq_saved_post_user",
      },
      {
        fields: ["userId", "createdAt"],
        name: "idx_saved_posts_user_created",
      },
    ],
  }
);

export default SavedPost;
