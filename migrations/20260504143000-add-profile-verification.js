"use strict";

const USERS_TABLE_CANDIDATES = ["Users", "users"];
const REQUESTS_TABLE = "profile_verification_requests";
const IDX_REQUESTS_USER_STATUS = "idx_profile_verification_requests_user_status";
const IDX_REQUESTS_STATUS_CREATED = "idx_profile_verification_requests_status_created";

const resolveUsersTable = async (queryInterface) => {
  for (const tableName of USERS_TABLE_CANDIDATES) {
    const exists = await queryInterface
      .describeTable(tableName)
      .then(() => true)
      .catch(() => false);
    if (exists) return tableName;
  }
  throw new Error("users table not found");
};

const addUserColumnIfMissing = async (queryInterface, tableName, column, definition) => {
  const table = await queryInterface.describeTable(tableName);
  if (table[column]) return;
  await queryInterface.addColumn(tableName, column, definition);
};

const removeUserColumnIfExists = async (queryInterface, tableName, column) => {
  const table = await queryInterface.describeTable(tableName);
  if (!table[column]) return;
  await queryInterface.removeColumn(tableName, column);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const usersTable = await resolveUsersTable(queryInterface);

    await addUserColumnIfMissing(queryInterface, usersTable, "profile_verified", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await addUserColumnIfMissing(queryInterface, usersTable, "profile_verification_status", {
      type: Sequelize.STRING(32),
      allowNull: false,
      defaultValue: "unverified",
    });

    await addUserColumnIfMissing(queryInterface, usersTable, "profile_verified_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await addUserColumnIfMissing(
      queryInterface,
      usersTable,
      "profile_verification_last_submitted_at",
      {
        type: Sequelize.DATE,
        allowNull: true,
      }
    );

    await addUserColumnIfMissing(
      queryInterface,
      usersTable,
      "profile_verification_failure_reason",
      {
        type: Sequelize.STRING(255),
        allowNull: true,
      }
    );

    await addUserColumnIfMissing(queryInterface, usersTable, "profile_verification_reviewed_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await addUserColumnIfMissing(queryInterface, usersTable, "profile_verification_reviewed_by", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    const requestsExists = await queryInterface
      .describeTable(REQUESTS_TABLE)
      .then(() => true)
      .catch(() => false);

    if (!requestsExists) {
      await queryInterface.createTable(REQUESTS_TABLE, {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: usersTable, key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: "pending",
        },
        decisionSource: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: "system",
        },
        attemptNumber: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        provider: {
          type: Sequelize.STRING(120),
          allowNull: true,
        },
        providerRequestId: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        selfieImageId: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        documentFrontImageId: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        documentBackImageId: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        selfieWithDocumentImageId: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        docType: {
          type: Sequelize.STRING(40),
          allowNull: true,
        },
        docCountry: {
          type: Sequelize.STRING(16),
          allowNull: true,
        },
        ageYears: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        isAdult: {
          type: Sequelize.BOOLEAN,
          allowNull: true,
        },
        faceMatchScore: {
          type: Sequelize.DOUBLE,
          allowNull: true,
        },
        livenessScore: {
          type: Sequelize.DOUBLE,
          allowNull: true,
        },
        documentConfidenceScore: {
          type: Sequelize.DOUBLE,
          allowNull: true,
        },
        overallConfidenceScore: {
          type: Sequelize.DOUBLE,
          allowNull: true,
        },
        failureCode: {
          type: Sequelize.STRING(120),
          allowNull: true,
        },
        failureReason: {
          type: Sequelize.STRING(255),
          allowNull: true,
        },
        autoDecisionAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        reviewedByUserId: {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        reviewedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        submittedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
        },
        meta: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        providerResponse: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        },
      });
    }

    const indexes = await queryInterface.showIndex(REQUESTS_TABLE);
    if (!indexes.some((idx) => idx.name === IDX_REQUESTS_USER_STATUS)) {
      await queryInterface.addIndex(REQUESTS_TABLE, ["userId", "status"], {
        name: IDX_REQUESTS_USER_STATUS,
      });
    }
    if (!indexes.some((idx) => idx.name === IDX_REQUESTS_STATUS_CREATED)) {
      await queryInterface.addIndex(REQUESTS_TABLE, ["status", "createdAt"], {
        name: IDX_REQUESTS_STATUS_CREATED,
      });
    }
  },

  async down(queryInterface) {
    const usersTable = await resolveUsersTable(queryInterface);

    const requestsExists = await queryInterface
      .describeTable(REQUESTS_TABLE)
      .then(() => true)
      .catch(() => false);
    if (requestsExists) {
      const indexes = await queryInterface.showIndex(REQUESTS_TABLE);
      if (indexes.some((idx) => idx.name === IDX_REQUESTS_USER_STATUS)) {
        await queryInterface.removeIndex(REQUESTS_TABLE, IDX_REQUESTS_USER_STATUS);
      }
      if (indexes.some((idx) => idx.name === IDX_REQUESTS_STATUS_CREATED)) {
        await queryInterface.removeIndex(REQUESTS_TABLE, IDX_REQUESTS_STATUS_CREATED);
      }
      await queryInterface.dropTable(REQUESTS_TABLE);
    }

    await removeUserColumnIfExists(queryInterface, usersTable, "profile_verification_reviewed_by");
    await removeUserColumnIfExists(queryInterface, usersTable, "profile_verification_reviewed_at");
    await removeUserColumnIfExists(
      queryInterface,
      usersTable,
      "profile_verification_failure_reason"
    );
    await removeUserColumnIfExists(
      queryInterface,
      usersTable,
      "profile_verification_last_submitted_at"
    );
    await removeUserColumnIfExists(queryInterface, usersTable, "profile_verified_at");
    await removeUserColumnIfExists(queryInterface, usersTable, "profile_verification_status");
    await removeUserColumnIfExists(queryInterface, usersTable, "profile_verified");
  },
};
