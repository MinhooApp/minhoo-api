"use strict";

const TABLE_NAME = "chat_groups";
const COLUMN_NAME = "chatId";

module.exports = {
  async up(queryInterface, Sequelize) {
    let table;
    try {
      table = await queryInterface.describeTable(TABLE_NAME);
    } catch (_error) {
      return;
    }

    if (!table[COLUMN_NAME]) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
    }

    const indexName = "idx_chat_groups_chat_id";
    const existingIndexes = await queryInterface.showIndex(TABLE_NAME);
    const hasIndex = existingIndexes.some((idx) => idx.name === indexName);
    if (!hasIndex) {
      await queryInterface.addIndex(TABLE_NAME, [COLUMN_NAME], {
        name: indexName,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE_NAME);
    if (!table[COLUMN_NAME]) return;
    try {
      await queryInterface.removeIndex(TABLE_NAME, "idx_chat_groups_chat_id");
    } catch (_error) {
      // ignore if index does not exist
    }
    await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
  },
};
