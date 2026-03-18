import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class GroupJoinRequest extends Model {
  [x: string]: any;
}

GroupJoinRequest.init(
  {
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inviteId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("pending", "approved", "rejected"),
      allowNull: false,
      defaultValue: "pending",
    },
    reviewedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    note: {
      type: DataTypes.STRING(280),
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "GroupJoinRequest",
    tableName: "chat_group_join_requests",
  }
);

export default GroupJoinRequest;
