import { DataTypes, Model } from "sequelize";
import sequelize from "../../_db/connection";

class ProfileVerificationRequest extends Model {
  [x: string]: any;
}

ProfileVerificationRequest.init(
  {
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "pending",
    },
    decisionSource: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "system",
    },
    attemptNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    provider: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    providerRequestId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    selfieImageId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    documentFrontImageId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    documentBackImageId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    selfieWithDocumentImageId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    docType: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    docCountry: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    ageYears: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    isAdult: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    faceMatchScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    livenessScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    documentConfidenceScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    overallConfidenceScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    failureCode: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    failureReason: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    autoDecisionAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    reviewedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    submittedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    providerResponse: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "profile_verification_request",
    tableName: "profile_verification_requests",
  }
);

export default ProfileVerificationRequest;
