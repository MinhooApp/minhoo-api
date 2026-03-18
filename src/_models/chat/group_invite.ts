import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class GroupInvite extends Model {
  [x: string]: any;
}

GroupInvite.init(
  {
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdByUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(24),
      allowNull: false,
      unique: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    maxUses: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    usesCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    modelName: "GroupInvite",
    tableName: "chat_group_invites",
  }
);

export default GroupInvite;
