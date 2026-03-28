"use strict";

const TABLE_NAME = "chat_user";
const INDEX_NAME = "idx_chat_user_user_pinned_updated_chat";
const INDEX_FIELDS = ["userId", "pinnedAt", "updatedAt", "chatId"];

const tableExists = async (queryInterface, tableName) => {
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (_error) {
    return false;
  }
};

const normalizeField = (field) =>
  String(field?.attribute ?? field?.name ?? "")
    .trim();

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

module.exports = {
  async up(queryInterface) {
    if (!(await tableExists(queryInterface, TABLE_NAME))) return;
    const indexes = await queryInterface.showIndex(TABLE_NAME);
    if (hasIndexByName(indexes, INDEX_NAME)) return;
    if (hasEquivalentIndex(indexes, INDEX_FIELDS)) return;

    await queryInterface.addIndex(TABLE_NAME, INDEX_FIELDS, {
      name: INDEX_NAME,
    });
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, TABLE_NAME))) return;
    const indexes = await queryInterface.showIndex(TABLE_NAME);
    if (!hasIndexByName(indexes, INDEX_NAME)) return;
    await queryInterface.removeIndex(TABLE_NAME, INDEX_NAME);
  },
};

