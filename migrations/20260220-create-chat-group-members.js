"use strict";

const TABLE_NAME = "chat_group_members";

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
      role: {
        type: Sequelize.ENUM("owner", "admin", "member"),
        allowNull: false,
        defaultValue: "member",
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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
      name: "uniq_chat_group_members_group_user",
      unique: true,
    });
    await queryInterface.addIndex(TABLE_NAME, ["groupId", "isActive"], {
      name: "idx_chat_group_members_group_active",
    });
    await queryInterface.addIndex(TABLE_NAME, ["userId", "isActive"], {
      name: "idx_chat_group_members_user_active",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE_NAME);
  },
};
