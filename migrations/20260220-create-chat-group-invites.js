"use strict";

const TABLE_NAME = "chat_group_invites";

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
      createdByUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      code: {
        type: Sequelize.STRING(24),
        allowNull: false,
        unique: true,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      maxUses: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 100,
      },
      usesCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
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

    await queryInterface.addIndex(TABLE_NAME, ["code"], {
      name: "uniq_chat_group_invites_code",
      unique: true,
    });
    await queryInterface.addIndex(TABLE_NAME, ["groupId", "isActive"], {
      name: "idx_chat_group_invites_group_active",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE_NAME);
  },
};
