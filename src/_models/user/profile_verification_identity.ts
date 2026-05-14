import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ProfileVerificationIdentity extends Model {
  [x: string]: any;
}

ProfileVerificationIdentity.init(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    requestId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "active",
    },
    decisionSource: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    provider: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    documentFingerprint: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    personFingerprint: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    nameFingerprint: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    documentLast4: {
      type: DataTypes.STRING(8),
      allowNull: true,
    },
    docType: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    docCountry: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "profile_verification_identity",
    tableName: "profile_verification_identities",
  }
);

export default ProfileVerificationIdentity;
