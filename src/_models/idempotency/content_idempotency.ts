import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ContentIdempotency extends Model {
  [x: string]: any;
}

ContentIdempotency.init(
  {
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    endpoint: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    idempotency_key: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    payload_hash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("processing", "completed"),
      allowNull: false,
      defaultValue: "processing",
    },
    response_status: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    response_body: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    resource_id: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: "content_idempotency",
    tableName: "content_idempotency",
    indexes: [
      {
        name: "uniq_content_idempotency_user_endpoint_key",
        unique: true,
        fields: ["user_id", "endpoint", "idempotency_key"],
      },
      {
        name: "idx_content_idempotency_expires_at",
        fields: ["expires_at"],
      },
    ],
  }
);

export default ContentIdempotency;
