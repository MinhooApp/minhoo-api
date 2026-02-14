import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Worker extends Model {
  [x: string]: any;
}
Worker.init(
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
    planId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: {
          msg: "The field 'planId' can't be null",
        },
        notEmpty: {
          msg: "The field 'planId' can't be empty",
        },
      },
    },
    about: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    rate: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
      validate: {
        notNull: {
          msg: "The field 'rate' can't be null",
        },
        notEmpty: {
          msg: "The field 'rate' can't be empty",
        },
      },
    },
    alert: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      validate: {
        notNull: {
          msg: "The alert 'available' can't be null",
        },
        notEmpty: {
          msg: "The alert 'available' can't be empty",
        },
      },
    },
    available: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      validate: {
        notNull: {
          msg: "The field 'available' can't be null",
        },
        notEmpty: {
          msg: "The field 'available' can't be empty",
        },
      },
    },
    visible: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    modelName: "worker",
  }
);
export default Worker;
