"use strict";

/**
 * Gap indexes for the notifications table:
 *
 * 1. idx_notifications_user_deleted_id
 *    Covers cursor-based pagination:
 *    WHERE userId = X AND deleted = false AND id < cursor ORDER BY id DESC
 *    The existing idx_notifications_user_deleted_read (userId, deleted, read) lacks `id`,
 *    forcing MySQL to filesort on users with large notification sets.
 *
 * 2. idx_notifications_comment_id
 *    Covers findActiveCommentNotifications:
 *    WHERE type = 'comment' AND commentId = X AND deleted = false
 *    No prior index on commentId — full scan on every comment delete/cleanup.
 */

const INDEX_DEFINITIONS = [
  {
    table: "notifications",
    name: "idx_notifications_user_deleted_id",
    fields: ["userId", "deleted", "id"],
  },
  {
    table: "notifications",
    name: "idx_notifications_comment_id",
    fields: ["commentId"],
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
  String(field?.attribute ?? field?.name ?? "").trim();

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

const dropIndexIfExists = async (queryInterface, definition) => {
  if (!(await tableExists(queryInterface, definition.table))) return;

  const indexes = await queryInterface.showIndex(definition.table);
  if (!hasIndexByName(indexes, definition.name)) return;

  await queryInterface.removeIndex(definition.table, definition.name);
};

module.exports = {
  async up(queryInterface) {
    for (const definition of INDEX_DEFINITIONS) {
      // Sequential to reduce lock contention on busy tables.
      // eslint-disable-next-line no-await-in-loop
      await ensureIndex(queryInterface, definition);
    }
  },

  async down(queryInterface) {
    for (const definition of [...INDEX_DEFINITIONS].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await dropIndexIfExists(queryInterface, definition);
    }
  },
};
