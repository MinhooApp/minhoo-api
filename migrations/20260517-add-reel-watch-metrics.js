"use strict";

const TABLE = "reels";

const COLUMNS = [
  {
    name: "watch_time_total_ms",
    definition: {
      type: "BIGINT",
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    name: "watch_count",
    definition: {
      type: "INTEGER",
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    name: "completion_count",
    definition: {
      type: "INTEGER",
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    name: "skip_count",
    definition: {
      type: "INTEGER",
      allowNull: false,
      defaultValue: 0,
    },
  },
];

const tableExists = async (queryInterface, tableName) => {
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (_error) {
    return false;
  }
};

const columnExists = async (queryInterface, tableName, columnName) => {
  const description = await queryInterface.describeTable(tableName);
  return columnName in description;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, TABLE))) return;

    for (const col of COLUMNS) {
      // eslint-disable-next-line no-await-in-loop
      if (await columnExists(queryInterface, TABLE, col.name)) continue;

      const typeMap = { BIGINT: Sequelize.BIGINT, INTEGER: Sequelize.INTEGER };
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.addColumn(TABLE, col.name, {
        type: typeMap[col.definition.type],
        allowNull: col.definition.allowNull,
        defaultValue: col.definition.defaultValue,
      });
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, TABLE))) return;

    for (const col of [...COLUMNS].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await columnExists(queryInterface, TABLE, col.name))) continue;
      // eslint-disable-next-line no-await-in-loop
      await queryInterface.removeColumn(TABLE, col.name);
    }
  },
};
