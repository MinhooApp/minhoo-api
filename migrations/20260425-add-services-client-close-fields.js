"use strict";

const TABLE_NAME = "services";
const CLOSED_AT_COLUMN = "closed_at";
const MANUAL_CLOSED_AT_COLUMN = "manual_closed_at";
const INDEX_MANUAL_CLOSED_AT = "idx_services_manual_closed_at";

const tableExists = async (queryInterface, tableName) => {
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE_NAME))) return;

    const definition = await queryInterface.describeTable(TABLE_NAME);

    if (!definition[CLOSED_AT_COLUMN]) {
      await queryInterface.addColumn(TABLE_NAME, CLOSED_AT_COLUMN, {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    if (!definition[MANUAL_CLOSED_AT_COLUMN]) {
      await queryInterface.addColumn(TABLE_NAME, MANUAL_CLOSED_AT_COLUMN, {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasManualClosedAtIndex = indexes.some(
      (index) => String(index?.name ?? "") === INDEX_MANUAL_CLOSED_AT
    );
    if (!hasManualClosedAtIndex) {
      await queryInterface.addIndex(TABLE_NAME, [MANUAL_CLOSED_AT_COLUMN], {
        name: INDEX_MANUAL_CLOSED_AT,
      });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, TABLE_NAME))) return;

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasManualClosedAtIndex = indexes.some(
      (index) => String(index?.name ?? "") === INDEX_MANUAL_CLOSED_AT
    );
    if (hasManualClosedAtIndex) {
      await queryInterface.removeIndex(TABLE_NAME, INDEX_MANUAL_CLOSED_AT);
    }

    const definition = await queryInterface.describeTable(TABLE_NAME);
    if (definition[MANUAL_CLOSED_AT_COLUMN]) {
      await queryInterface.removeColumn(TABLE_NAME, MANUAL_CLOSED_AT_COLUMN);
    }
    if (definition[CLOSED_AT_COLUMN]) {
      await queryInterface.removeColumn(TABLE_NAME, CLOSED_AT_COLUMN);
    }
  },
};
