"use strict";

const TABLE_NAME = "reel_reports";
const UNIQUE_INDEX = "uq_reel_reports_reel_reporter";
const REEL_INDEX = "idx_reel_reports_reel_id";
const REPORTER_INDEX = "idx_reel_reports_reporter_id";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableExists = await queryInterface
      .describeTable(TABLE_NAME)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) {
      await queryInterface.createTable(TABLE_NAME, {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        reelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "reels", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        reporterId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        reason: {
          type: Sequelize.STRING(120),
          allowNull: false,
          defaultValue: "something_else",
        },
        details: {
          type: Sequelize.TEXT,
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

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasUniqueIndex = indexes.some((idx) => idx.name === UNIQUE_INDEX);
    if (!hasUniqueIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["reelId", "reporterId"], {
        name: UNIQUE_INDEX,
        unique: true,
      });
    }

    const hasReelIndex = indexes.some((idx) => idx.name === REEL_INDEX);
    if (!hasReelIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["reelId"], {
        name: REEL_INDEX,
      });
    }

    const hasReporterIndex = indexes.some((idx) => idx.name === REPORTER_INDEX);
    if (!hasReporterIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["reporterId"], {
        name: REPORTER_INDEX,
      });
    }
  },

  async down(queryInterface) {
    const tableExists = await queryInterface
      .describeTable(TABLE_NAME)
      .then(() => true)
      .catch(() => false);

    if (!tableExists) return;

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasUniqueIndex = indexes.some((idx) => idx.name === UNIQUE_INDEX);
    if (hasUniqueIndex) {
      await queryInterface.removeIndex(TABLE_NAME, UNIQUE_INDEX);
    }

    const hasReelIndex = indexes.some((idx) => idx.name === REEL_INDEX);
    if (hasReelIndex) {
      await queryInterface.removeIndex(TABLE_NAME, REEL_INDEX);
    }

    const hasReporterIndex = indexes.some((idx) => idx.name === REPORTER_INDEX);
    if (hasReporterIndex) {
      await queryInterface.removeIndex(TABLE_NAME, REPORTER_INDEX);
    }

    await queryInterface.dropTable(TABLE_NAME);
  },
};
