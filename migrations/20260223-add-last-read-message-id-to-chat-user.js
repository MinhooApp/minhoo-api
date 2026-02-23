"use strict";

const TABLE_NAME = "chat_user";
const COLUMN_NAME = "lastReadMessageId";

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
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    let table;
    try {
      table = await queryInterface.describeTable(TABLE_NAME);
    } catch (_error) {
      return;
    }

    if (!table[COLUMN_NAME]) return;
    await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
  },
};
