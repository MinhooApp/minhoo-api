"use strict";

const TABLE_NAME = "chat_user";
const COLUMN_NAME = "unreadCount";

module.exports = {
  async up(queryInterface, Sequelize) {
    let table;
    try {
      table = await queryInterface.describeTable(TABLE_NAME);
    } catch (_error) {
      return;
    }

    if (!table[COLUMN_NAME]) {
      await queryInterface.addColumn(TABLE_NAME, COLUMN_NAME, {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }

    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === "mysql" || dialect === "mariadb") {
      await queryInterface.sequelize.query(
        `
          UPDATE chat_user cu
          LEFT JOIN (
            SELECT
              cu2.userId AS userId,
              m.chatId AS chatId,
              COUNT(*) AS unreadCount
            FROM messages m
            INNER JOIN chat_user cu2
              ON cu2.chatId = m.chatId
            WHERE m.senderId <> cu2.userId
              AND m.deletedBy IN (0, cu2.userId)
              AND m.status IN ('sent', 'delivered')
            GROUP BY cu2.userId, m.chatId
          ) agg
            ON agg.userId = cu.userId
           AND agg.chatId = cu.chatId
          SET cu.${COLUMN_NAME} = COALESCE(agg.unreadCount, 0)
        `
      );
    }
  },

  async down(queryInterface) {
    let table;
    try {
      table = await queryInterface.describeTable(TABLE_NAME);
    } catch (_error) {
      return;
    }

    if (!table[COLUMN_NAME]) return;
    await queryInterface.removeColumn(TABLE_NAME, COLUMN_NAME);
  },
};

