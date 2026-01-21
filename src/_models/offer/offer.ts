import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class Offer extends Model {
  [x: string]: any;
}

Offer.init(
  {
    serviceId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'serviceId' can't be null" },
        notEmpty: { msg: "The field 'serviceId' can't be empty" },
      },
    },
    workerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'workerId' can't be null" },
        notEmpty: { msg: "The field 'workerId' can't be empty" },
      },
    },
    offer: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'offer' can't be null" },
        notEmpty: { msg: "The field 'offer' can't be empty" },
      },
    },
    accepted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    canceled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    removed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    offer_date: {
      type: DataTypes.DATE,
      allowNull: false,
      validate: {
        notNull: { msg: "The field 'offer_date' can't be null" },
        notEmpty: { msg: "The field 'offer_date' can't be empty" },
      },
    },
  },
  {
    sequelize,
    modelName: "offer",

    // ✅ CLAVE: 1 worker solo puede tener 1 offer por service
    indexes: [
      {
        unique: true,
        fields: ["serviceId", "workerId"],
        name: "uniq_offer_service_worker",
      },
    ],
  }
);

export default Offer;
