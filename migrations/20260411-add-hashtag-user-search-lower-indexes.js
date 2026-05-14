"use strict";

const normalizeTableName = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    if (typeof entry.tableName === "string") return entry.tableName;
    if (typeof entry.TABLE_NAME === "string") return entry.TABLE_NAME;
  }
  return "";
};

const tableExists = async (queryInterface, tableName) => {
  const tablesRaw = await queryInterface.showAllTables();
  const tables = (tablesRaw || []).map(normalizeTableName).filter(Boolean);
  return tables.includes(tableName);
};

const indexExists = async (queryInterface, tableName, indexName) => {
  const indexes = await queryInterface.showIndex(tableName);
  return (indexes || []).some((idx) => String(idx?.name ?? "") === indexName);
};

const createIndexIfMissing = async (
  queryInterface,
  tableName,
  indexName,
  createSql
) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  if (await indexExists(queryInterface, tableName, indexName)) return;
  await queryInterface.sequelize.query(createSql);
};

const dropIndexIfExists = async (queryInterface, tableName, indexName) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  if (!(await indexExists(queryInterface, tableName, indexName))) return;
  await queryInterface.removeIndex(tableName, indexName);
};

module.exports = {
  async up(queryInterface) {
    await createIndexIfMissing(
      queryInterface,
      "users",
      "idx_users_lower_username",
      "CREATE INDEX idx_users_lower_username ON users ((LOWER(`username`)))"
    );

    await createIndexIfMissing(
      queryInterface,
      "users",
      "idx_users_lower_username_handle",
      "CREATE INDEX idx_users_lower_username_handle ON users ((LOWER(CONCAT('@', COALESCE(`username`, '')))))"
    );

    await createIndexIfMissing(
      queryInterface,
      "hashtags",
      "idx_hashtags_lower_tag",
      "CREATE INDEX idx_hashtags_lower_tag ON hashtags ((LOWER(`tag`)))"
    );
  },

  async down(queryInterface) {
    await dropIndexIfExists(queryInterface, "hashtags", "idx_hashtags_lower_tag");
    await dropIndexIfExists(queryInterface, "users", "idx_users_lower_username_handle");
    await dropIndexIfExists(queryInterface, "users", "idx_users_lower_username");
  },
};
