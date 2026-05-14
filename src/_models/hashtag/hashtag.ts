import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Hashtag extends Model {
  [x: string]: any;
}

Hashtag.init(
  {
    tag: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
      validate: {
        notNull: {
          msg: "The field 'tag' can't be null",
        },
        notEmpty: {
          msg: "The field 'tag' can't be empty",
        },
      },
    },
  },
  {
    sequelize,
    modelName: "hashtag",
    tableName: "hashtags",
    indexes: [{ name: "uq_hashtags_tag", unique: true, fields: ["tag"] }],
  }
);

export default Hashtag;
