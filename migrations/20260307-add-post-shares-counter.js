"use strict";

const TABLE_NAME = "posts";
const COLUMN_NAME = "shares_count";
const INDEX_NAME = "idx_posts_shares_count";

module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = await queryInterface.describeTable(TABLE_NAME);

    if (!schema[COLUMN_NAME]) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasIndex = indexes.some((idx) => idx.name === INDEX_NAME);
    if (!hasIndex) {
      await queryInterface.addIndex(TABLE_NAME, [COLUMN_NAME], {
        name: INDEX_NAME,
      });
    }
  },

  async down(queryInterface) {
    const schema = await queryInterface.describeTable(TABLE_NAME);
    const indexes = await queryInterface.showIndex(TABLE_NAME);

    const hasIndex = indexes.some((idx) => idx.name === INDEX_NAME);
    if (hasIndex) {
      await queryInterface.removeIndex(TABLE_NAME, INDEX_NAME);
    }

    if (schema[COLUMN_NAME]) {
      await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
    }
  },
};
