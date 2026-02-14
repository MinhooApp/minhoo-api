import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Service extends Model {
  [x: string]: any;
}

Service.init(
  {
    statusId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'statusId' can't be null" },
        notEmpty: { msg: "The field 'statusId' can't be empty" },
      },
      defaultValue: 1,
    },

    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'userId' can't be null" },
        notEmpty: { msg: "The field 'userId' can't be empty" },
      },
    },

    categoryId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'categoryId' can't be null" },
        notEmpty: { msg: "The field 'categoryId' can't be empty" },
      },
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'description' can't be null" },
        notEmpty: { msg: "The field 'description' can't be empty" },
      },
    },

    rate: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'rate' can't be null" },
        notEmpty: { msg: "The field 'rate' can't be empty" },
      },
    },

    // ✅ MONEDA: usas camelCase en código, pero guarda/lee snake_case en DB
    currencyCode: {
      type: DataTypes.STRING(10),
      allowNull: true,
      field: "currency_code",
    },
    currencyPrefix: {
      type: DataTypes.STRING(10),
      allowNull: true,
      field: "currency_prefix",
    },

    service_date: {
      type: DataTypes.DATE,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'service_date' can't be null" },
        notEmpty: { msg: "The field 'service_date' can't be empty" },
      },
    },

    on_site: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },

    longitude: { type: DataTypes.DOUBLE, allowNull: true },
    latitude: { type: DataTypes.DOUBLE, allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },

    net_pay: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'net_ay' can't be null" },
        notEmpty: { msg: "The field 'net_ay' can't be empty" },
      },
      defaultValue: true,
    },

    places: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'places' can't be null" },
        notEmpty: { msg: "The field 'places' can't be empty" },
      },
      defaultValue: 1,
    },

    is_available: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    sequelize,
    modelName: "service",
    // ✅ IMPORTANTE: NO pongas tableName aquí (eso fue lo que rompió prod)
    // ✅ IMPORTANTE: NO uses sync({ force: true }) en prod
  }
);

export default Service;


