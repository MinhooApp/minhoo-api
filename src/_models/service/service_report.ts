import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ServiceReport extends Model {
  [x: string]: any;
}

ServiceReport.init(
  {
    serviceId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'serviceId' can't be null" },
        notEmpty: { msg: "The field 'serviceId' can't be empty" },
      },
    },
    reporterId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'reporterId' can't be null" },
        notEmpty: { msg: "The field 'reporterId' can't be empty" },
      },
    },
    reason: {
      type: DataTypes.STRING(120),
      allowNull: false,
      defaultValue: "something_else",
    },
    details: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "service_report",
    tableName: "service_reports",
  }
);

export default ServiceReport;
