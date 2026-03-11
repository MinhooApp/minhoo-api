"use strict";

const TABLE_NAME = "notifications";
const COLUMN_NAME = "reelId";
const INDEX_NAME = "idx_notifications_reel_id";

module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = await queryInterface.describeTable(TABLE_NAME);

    if (!schema[COLUMN_NAME]) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "reels", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
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
