import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class GroupMember extends Model {
  [x: string]: any;
}

GroupMember.init(
  {
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    role: {
      type: DataTypes.ENUM("owner", "admin", "member"),
      allowNull: false,
      defaultValue: "member",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    modelName: "GroupMember",
    tableName: "chat_group_members",
  }
);

export default GroupMember;
