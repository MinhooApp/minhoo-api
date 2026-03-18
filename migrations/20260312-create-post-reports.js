"use strict";

const TABLE_NAME = "post_reports";
const UNIQUE_INDEX = "uq_post_reports_post_reporter";
const POST_INDEX = "idx_post_reports_post_id";
const REPORTER_INDEX = "idx_post_reports_reporter_id";

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
        postId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "posts", key: "id" },
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
      await queryInterface.addIndex(TABLE_NAME, ["postId", "reporterId"], {
        name: UNIQUE_INDEX,
        unique: true,
      });
    }

    const hasPostIndex = indexes.some((idx) => idx.name === POST_INDEX);
    if (!hasPostIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["postId"], {
        name: POST_INDEX,
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

    const hasPostIndex = indexes.some((idx) => idx.name === POST_INDEX);
    if (hasPostIndex) {
      await queryInterface.removeIndex(TABLE_NAME, POST_INDEX);
    }

    const hasReporterIndex = indexes.some((idx) => idx.name === REPORTER_INDEX);
    if (hasReporterIndex) {
      await queryInterface.removeIndex(TABLE_NAME, REPORTER_INDEX);
    }

    await queryInterface.dropTable(TABLE_NAME);
  },
};
