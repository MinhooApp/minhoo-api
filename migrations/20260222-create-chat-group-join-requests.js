"use strict";

const TABLE_NAME = "chat_group_join_requests";

module.exports = {
  async up(queryInterface, Sequelize) {
    let exists = true;
    try {
      await queryInterface.describeTable(TABLE_NAME);
    } catch (_error) {
      exists = false;
    }

    if (exists) return;

    await queryInterface.createTable(TABLE_NAME, {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      groupId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      inviteId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM("pending", "approved", "rejected"),
        allowNull: false,
        defaultValue: "pending",
      },
      reviewedByUserId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      reviewedAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      note: {
        type: Sequelize.STRING(280),
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex(TABLE_NAME, ["groupId", "userId"], {
      name: "uniq_chat_group_join_requests_group_user",
      unique: true,
    });
    await queryInterface.addIndex(TABLE_NAME, ["groupId", "status"], {
      name: "idx_chat_group_join_requests_group_status",
    });
    await queryInterface.addIndex(TABLE_NAME, ["userId", "status"], {
      name: "idx_chat_group_join_requests_user_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE_NAME);
  },
};
