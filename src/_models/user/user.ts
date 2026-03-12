import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class User extends Model {
  [x: string]: any;
}
User.init(
  {
    countryId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cityId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    planId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      validate: {
        notNull: {
          msg: "The field 'planId' can't be null",
        },
        notEmpty: {
          msg: "The field 'planId' can't be empty",
        },
      },
    },
    dni: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    last_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    birthday: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notNull: {
          msg: "The field 'email' can't be null",
        },
        notEmpty: {
          msg: "The field 'email' can't be empty",
        },
      },
    },
    dialing_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    iso_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      //unique: true,
      allowNull: true,
    },
    language: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    uuid: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    username: {
      type: DataTypes.STRING(30),
      allowNull: true,
      unique: true,
    },
    username_updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    job_category_ids: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    job_categories_labels: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    language_ids: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    language_codes: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    language_names: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    country_origin_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    country_origin_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    country_residence_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    state_residence_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    state_residence_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    city_residence_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    city_residence_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    auth_token: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    image_profil: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue:
        "https://imagedelivery.net/byMb3jxLYxr0Esz1Tf7NcQ/ff67a5c9-2984-45be-9502-925d46939100/public",
      get() {
        const raw = this.getDataValue("image_profil");
        if (!raw) return raw;
        const value = String(raw);
        if (/^https?:\/\//i.test(value) || value.startsWith("data:")) {
          return value;
        }
        const normalized = value.replace(/\\/g, "/");
        return normalized.startsWith("/") ? normalized : `/${normalized}`;
      },
      validate: {
        notNull: {
          msg: "The field 'image_profil' can't be null",
        },
        notEmpty: {
          msg: "The field 'image_profil' can't be empty",
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
    last_longitude: {
      type: DataTypes.DECIMAL,
      allowNull: true,
    },
    last_latitude: {
      type: DataTypes.DECIMAL,
      allowNull: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    temp_code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    created_temp_code: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    verified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    available: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    disabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    show_email: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    show_phone: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    show_languages: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    show_location: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    is_deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "user",
  }
);
export default User;
