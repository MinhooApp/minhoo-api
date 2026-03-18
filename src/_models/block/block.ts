import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class UserBlock extends Model {
  [x: string]: any;
}

UserBlock.init(
  {
    blocker_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'blocker_id' can't be null",
        },
        notEmpty: {
          msg: "The field 'blocker_id' can't be empty",
        },
      },
    },
    blocked_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'blocked_id' can't be null",
        },
        notEmpty: {
          msg: "The field 'blocked_id' can't be empty",
        },
      },
    },
  },

  {
    sequelize,
    modelName: "user_blocks",
    tableName: "user_blocks",
  }
);

export default UserBlock;
