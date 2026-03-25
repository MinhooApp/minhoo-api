"use strict";

const TABLE_NAME = "chat_reports";
const UNIQUE_INDEX = "uq_chat_reports_chat_reporter_message";
const CHAT_INDEX = "idx_chat_reports_chat_id";
const MESSAGE_INDEX = "idx_chat_reports_message_id";
const REPORTER_INDEX = "idx_chat_reports_reporter_id";

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
        chatId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "chats", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        messageId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: "messages", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
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
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
          ),
        },
      });
    }

    const indexes = await queryInterface.showIndex(TABLE_NAME);

    const hasUniqueIndex = indexes.some((idx) => idx.name === UNIQUE_INDEX);
    if (!hasUniqueIndex) {
      await queryInterface.addIndex(
        TABLE_NAME,
        ["chatId", "reporterId", "messageId"],
        {
          name: UNIQUE_INDEX,
          unique: true,
        }
      );
    }

    const hasChatIndex = indexes.some((idx) => idx.name === CHAT_INDEX);
    if (!hasChatIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["chatId"], {
        name: CHAT_INDEX,
      });
    }

    const hasMessageIndex = indexes.some((idx) => idx.name === MESSAGE_INDEX);
    if (!hasMessageIndex) {
      await queryInterface.addIndex(TABLE_NAME, ["messageId"], {
        name: MESSAGE_INDEX,
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

    const hasChatIndex = indexes.some((idx) => idx.name === CHAT_INDEX);
    if (hasChatIndex) {
      await queryInterface.removeIndex(TABLE_NAME, CHAT_INDEX);
    }

    const hasMessageIndex = indexes.some((idx) => idx.name === MESSAGE_INDEX);
    if (hasMessageIndex) {
      await queryInterface.removeIndex(TABLE_NAME, MESSAGE_INDEX);
    }

    const hasReporterIndex = indexes.some((idx) => idx.name === REPORTER_INDEX);
    if (hasReporterIndex) {
      await queryInterface.removeIndex(TABLE_NAME, REPORTER_INDEX);
    }

    await queryInterface.dropTable(TABLE_NAME);
  },
};
