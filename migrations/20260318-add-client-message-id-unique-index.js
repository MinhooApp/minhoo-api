"use strict";

const TABLE_NAME = "messages";
const COLUMN_NAME = "clientMessageId";
const UNIQUE_INDEX_NAME = "uq_messages_chat_sender_client_message_id";

const indexExists = async (queryInterface, indexName) => {
  const indexes = await queryInterface.showIndex(TABLE_NAME);
  return indexes.some((index) => String(index?.name ?? "") === indexName);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE_NAME);

    if (!table[COLUMN_NAME]) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.STRING(128),
        allowNull: true,
      });
    }

    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === "mysql" || dialect === "mariadb") {
      // Backfill best-effort from legacy metadata key.
      await queryInterface.sequelize.query(
        `UPDATE \`${TABLE_NAME}\`
         SET \`${COLUMN_NAME}\` = NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(\`metadata\`, '$._clientMessageId'))), '')
         WHERE \`${COLUMN_NAME}\` IS NULL
           AND JSON_EXTRACT(\`metadata\`, '$._clientMessageId') IS NOT NULL`
      );

      // Keep values in column size bounds.
      await queryInterface.sequelize.query(
        `UPDATE \`${TABLE_NAME}\`
         SET \`${COLUMN_NAME}\` = LEFT(\`${COLUMN_NAME}\`, 128)
         WHERE \`${COLUMN_NAME}\` IS NOT NULL
           AND CHAR_LENGTH(\`${COLUMN_NAME}\`) > 128`
      );

      // If legacy duplicates exist, keep newest id and clear older ones.
      await queryInterface.sequelize.query(
        `UPDATE \`${TABLE_NAME}\` AS m
         JOIN (
           SELECT \`chatId\`, \`senderId\`, \`${COLUMN_NAME}\`, MAX(\`id\`) AS keep_id, COUNT(*) AS qty
           FROM \`${TABLE_NAME}\`
           WHERE \`${COLUMN_NAME}\` IS NOT NULL AND \`${COLUMN_NAME}\` <> ''
           GROUP BY \`chatId\`, \`senderId\`, \`${COLUMN_NAME}\`
           HAVING qty > 1
         ) dup
           ON dup.\`chatId\` = m.\`chatId\`
          AND dup.\`senderId\` = m.\`senderId\`
          AND dup.\`${COLUMN_NAME}\` = m.\`${COLUMN_NAME}\`
          AND m.\`id\` <> dup.keep_id
         SET m.\`${COLUMN_NAME}\` = NULL`
      );
    }

    if (!(await indexExists(queryInterface, UNIQUE_INDEX_NAME))) {
      await queryInterface.addIndex(TABLE_NAME, ["chatId", "senderId", COLUMN_NAME], {
        name: UNIQUE_INDEX_NAME,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE_NAME);

    if (await indexExists(queryInterface, UNIQUE_INDEX_NAME)) {
      await queryInterface.removeIndex(TABLE_NAME, UNIQUE_INDEX_NAME);
    }

    if (table[COLUMN_NAME]) {
      await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
    }
  },
};

