import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Group extends Model {
  [x: string]: any;
}

Group.init(
  {
    ownerUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ownerUsername: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(280),
      allowNull: true,
    },
    avatarUrl: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    chatId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    maxMembers: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 256,
    },
    joinMode: {
      type: DataTypes.ENUM("private", "public_with_approval"),
      allowNull: false,
      defaultValue: "public_with_approval",
    },
    writeMode: {
      type: DataTypes.ENUM("all_members", "admins_only"),
      allowNull: false,
      defaultValue: "all_members",
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    modelName: "Group",
    tableName: "chat_groups",
  }
);

export default Group;
