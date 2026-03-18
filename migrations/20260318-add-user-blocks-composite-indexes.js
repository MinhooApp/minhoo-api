"use strict";

const TABLE_NAME = "user_blocks";

const INDEXES = [
  {
    name: "idx_user_blocks_blocker_blocked",
    fields: ["blocker_id", "blocked_id"],
  },
  {
    name: "idx_user_blocks_blocked_blocker",
    fields: ["blocked_id", "blocker_id"],
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

const normalizeField = (field) => String(field?.attribute ?? field?.name ?? "").trim();

const sameOrderedFields = (left, right) =>
  left.length === right.length && left.every((value, idx) => value === right[idx]);

const hasIndexByName = (indexes, indexName) =>
  indexes.some((index) => String(index?.name ?? "") === indexName);

const hasEquivalentIndex = (indexes, expectedFields) =>
  indexes.some((index) => {
    const fields = Array.isArray(index?.fields)
      ? index.fields.map(normalizeField).filter(Boolean)
      : [];
    return sameOrderedFields(fields, expectedFields);
  });

const ensureIndex = async (queryInterface, definition) => {
  if (!(await tableExists(queryInterface, TABLE_NAME))) return;

  const indexes = await queryInterface.showIndex(TABLE_NAME);
  if (hasIndexByName(indexes, definition.name)) return;
  if (hasEquivalentIndex(indexes, definition.fields)) return;

  await queryInterface.addIndex(TABLE_NAME, definition.fields, {
    name: definition.name,
  });
};

const dropIndexIfExists = async (queryInterface, indexName) => {
  if (!(await tableExists(queryInterface, TABLE_NAME))) return;

  const indexes = await queryInterface.showIndex(TABLE_NAME);
  if (!hasIndexByName(indexes, indexName)) return;

  await queryInterface.removeIndex(TABLE_NAME, indexName);
};

module.exports = {
  async up(queryInterface) {
    for (const index of INDEXES) {
      await ensureIndex(queryInterface, index);
    }
  },

  async down(queryInterface) {
    for (const index of [...INDEXES].reverse()) {
      await dropIndexIfExists(queryInterface, index.name);
    }
  },
};

