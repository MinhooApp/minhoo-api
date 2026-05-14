"use strict";

const USERS_TABLE_CANDIDATES = ["Users", "users"];
const REQUESTS_TABLE = "profile_verification_requests";
const IDENTITIES_TABLE = "profile_verification_identities";

const IDX_IDENTITIES_USER = "idx_profile_verif_identities_user";
const IDX_IDENTITIES_REQUEST = "idx_profile_verif_identities_request";
const UQ_IDENTITIES_DOCUMENT = "uq_profile_verif_identities_document";
const UQ_IDENTITIES_PERSON = "uq_profile_verif_identities_person";

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

const tableExists = async (queryInterface, tableName) =>
  queryInterface
    .describeTable(tableName)
    .then(() => true)
    .catch(() => false);

module.exports = {
  async up(queryInterface, Sequelize) {
    const usersTable = await resolveUsersTable(queryInterface);
    const hasRequestsTable = await tableExists(queryInterface, REQUESTS_TABLE);

    const hasIdentitiesTable = await tableExists(queryInterface, IDENTITIES_TABLE);
    if (!hasIdentitiesTable) {
      await queryInterface.createTable(IDENTITIES_TABLE, {
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
        requestId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          ...(hasRequestsTable
            ? {
                references: { model: REQUESTS_TABLE, key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
              }
            : {}),
        },
        status: {
          type: Sequelize.STRING(32),
          allowNull: false,
          defaultValue: "active",
        },
        decisionSource: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        provider: {
          type: Sequelize.STRING(120),
          allowNull: true,
        },
        documentFingerprint: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        personFingerprint: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        nameFingerprint: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        documentLast4: {
          type: Sequelize.STRING(8),
          allowNull: true,
        },
        docType: {
          type: Sequelize.STRING(40),
          allowNull: true,
        },
        docCountry: {
          type: Sequelize.STRING(16),
          allowNull: true,
        },
        meta: {
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

    const indexes = await queryInterface.showIndex(IDENTITIES_TABLE);
    if (!indexes.some((idx) => idx.name === IDX_IDENTITIES_USER)) {
      await queryInterface.addIndex(IDENTITIES_TABLE, ["userId"], {
        name: IDX_IDENTITIES_USER,
      });
    }
    if (!indexes.some((idx) => idx.name === IDX_IDENTITIES_REQUEST)) {
      await queryInterface.addIndex(IDENTITIES_TABLE, ["requestId"], {
        name: IDX_IDENTITIES_REQUEST,
      });
    }
    if (!indexes.some((idx) => idx.name === UQ_IDENTITIES_DOCUMENT)) {
      await queryInterface.addIndex(IDENTITIES_TABLE, ["documentFingerprint"], {
        name: UQ_IDENTITIES_DOCUMENT,
        unique: true,
      });
    }
    if (!indexes.some((idx) => idx.name === UQ_IDENTITIES_PERSON)) {
      await queryInterface.addIndex(IDENTITIES_TABLE, ["personFingerprint"], {
        name: UQ_IDENTITIES_PERSON,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    const hasIdentitiesTable = await tableExists(queryInterface, IDENTITIES_TABLE);
    if (!hasIdentitiesTable) return;

    const indexes = await queryInterface.showIndex(IDENTITIES_TABLE);
    if (indexes.some((idx) => idx.name === UQ_IDENTITIES_PERSON)) {
      await queryInterface.removeIndex(IDENTITIES_TABLE, UQ_IDENTITIES_PERSON);
    }
    if (indexes.some((idx) => idx.name === UQ_IDENTITIES_DOCUMENT)) {
      await queryInterface.removeIndex(IDENTITIES_TABLE, UQ_IDENTITIES_DOCUMENT);
    }
    if (indexes.some((idx) => idx.name === IDX_IDENTITIES_REQUEST)) {
      await queryInterface.removeIndex(IDENTITIES_TABLE, IDX_IDENTITIES_REQUEST);
    }
    if (indexes.some((idx) => idx.name === IDX_IDENTITIES_USER)) {
      await queryInterface.removeIndex(IDENTITIES_TABLE, IDX_IDENTITIES_USER);
    }

    await queryInterface.dropTable(IDENTITIES_TABLE);
  },
};
