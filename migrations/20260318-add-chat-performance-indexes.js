"use strict";

const MESSAGES_TABLE = "messages";
const CHAT_USER_TABLE = "chat_user";

const INDEX_DEFINITIONS = [
  {
    table: MESSAGES_TABLE,
    name: "idx_messages_chat_deleted_id",
    fields: ["chatId", "deletedBy", "id"],
  },
  {
    table: MESSAGES_TABLE,
    name: "idx_messages_chat_sender_deleted_status",
    fields: ["chatId", "senderId", "deletedBy", "status"],
  },
  {
    table: CHAT_USER_TABLE,
    name: "idx_chat_user_user_pinned_chat",
    fields: ["userId", "pinnedAt", "chatId"],
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

const ensureIndex = async (queryInterface, definition) => {
  if (!(await tableExists(queryInterface, definition.table))) return;

  const indexes = await queryInterface.showIndex(definition.table);
  if (hasIndexByName(indexes, definition.name)) return;
  if (hasEquivalentIndex(indexes, definition.fields)) return;

  await queryInterface.addIndex(definition.table, definition.fields, {
    name: definition.name,
  });
};

const dropIndexByNameIfExists = async (queryInterface, definition) => {
  if (!(await tableExists(queryInterface, definition.table))) return;

  const indexes = await queryInterface.showIndex(definition.table);
  if (!hasIndexByName(indexes, definition.name)) return;

  await queryInterface.removeIndex(definition.table, definition.name);
};

module.exports = {
  async up(queryInterface) {
    for (const definition of INDEX_DEFINITIONS) {
      await ensureIndex(queryInterface, definition);
    }
  },

  async down(queryInterface) {
    for (const definition of [...INDEX_DEFINITIONS].reverse()) {
      await dropIndexByNameIfExists(queryInterface, definition);
    }
  },
};

