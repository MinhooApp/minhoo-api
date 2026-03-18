"use strict";

const TABLE_NAME = "saved_posts";

const normalizeTableName = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    if (typeof entry.tableName === "string") return entry.tableName;
    if (typeof entry.TABLE_NAME === "string") return entry.TABLE_NAME;
  }
  return "";
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const tablesRaw = await queryInterface.showAllTables();
    const tables = (tablesRaw || []).map(normalizeTableName).filter(Boolean);

    if (!tables.includes(TABLE_NAME)) {
      await queryInterface.createTable(TABLE_NAME, {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: "users",
            key: "id",
          },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        postId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: "posts",
            key: "id",
          },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
        },
      });
    }

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasUnique = indexes.some((idx) => idx.name === "uniq_saved_post_user");
    if (!hasUnique) {
      await queryInterface.addIndex(TABLE_NAME, ["userId", "postId"], {
        unique: true,
        name: "uniq_saved_post_user",
      });
    }

    const hasUserCreated = indexes.some(
      (idx) => idx.name === "idx_saved_posts_user_created"
    );
    if (!hasUserCreated) {
      await queryInterface.addIndex(TABLE_NAME, ["userId", "createdAt"], {
        name: "idx_saved_posts_user_created",
      });
    }
  },

  async down(queryInterface) {
    const tablesRaw = await queryInterface.showAllTables();
    const tables = (tablesRaw || []).map(normalizeTableName).filter(Boolean);
    if (tables.includes(TABLE_NAME)) {
      await queryInterface.dropTable(TABLE_NAME);
    }
  },
};
