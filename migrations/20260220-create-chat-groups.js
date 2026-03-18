"use strict";

const TABLE_NAME = "chat_groups";

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
      ownerUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      ownerUsername: {
        type: Sequelize.STRING(30),
        allowNull: true,
      },
      name: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      description: {
        type: Sequelize.STRING(280),
        allowNull: true,
      },
      avatarUrl: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      maxMembers: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 256,
      },
      joinMode: {
        type: Sequelize.ENUM("private", "public_with_approval"),
        allowNull: false,
        defaultValue: "public_with_approval",
      },
      writeMode: {
        type: Sequelize.ENUM("all_members", "admins_only"),
        allowNull: false,
        defaultValue: "all_members",
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

    await queryInterface.addIndex(TABLE_NAME, ["ownerUserId", "isActive"], {
      name: "idx_chat_groups_owner_active",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE_NAME);
  },
};
