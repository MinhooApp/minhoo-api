import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ServiceRating extends Model {
  [x: string]: any;
}

ServiceRating.init(
  {
    serviceId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    reviewerUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    reviewerWorkerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    revieweeUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    revieweeWorkerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    revieweeRole: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    overall: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    quality: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    communication: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    reliability: {
      type: DataTypes.TINYINT.UNSIGNED,
      allowNull: false,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    reported: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    reportReason: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    reportedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "service_rating",
    tableName: "service_ratings",
  }
);

export default ServiceRating;
