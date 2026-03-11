"use strict";

const TABLE_NAME = "posts";

module.exports = {
  async up(queryInterface, Sequelize) {
    const schema = await queryInterface.describeTable(TABLE_NAME);

    if (!schema.likes_count) {
      await queryInterface.addColumn(TABLE_NAME, "likes_count", {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!schema.saves_count) {
      await queryInterface.addColumn(TABLE_NAME, "saves_count", {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    }

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasLikesIdx = indexes.some((idx) => idx.name === "idx_posts_likes_count");
    if (!hasLikesIdx) {
      await queryInterface.addIndex(TABLE_NAME, ["likes_count"], {
        name: "idx_posts_likes_count",
      });
    }

    const hasSavesIdx = indexes.some((idx) => idx.name === "idx_posts_saves_count");
    if (!hasSavesIdx) {
      await queryInterface.addIndex(TABLE_NAME, ["saves_count"], {
        name: "idx_posts_saves_count",
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE posts p
      LEFT JOIN (
        SELECT postId, COUNT(*) AS cnt
        FROM likes
        WHERE postId IS NOT NULL
        GROUP BY postId
      ) l ON l.postId = p.id
      LEFT JOIN (
        SELECT postId, COUNT(*) AS cnt
        FROM saved_posts
        GROUP BY postId
      ) s ON s.postId = p.id
      SET p.likes_count = COALESCE(l.cnt, 0),
          p.saves_count = COALESCE(s.cnt, 0)
    `);
  },

  async down(queryInterface) {
    const schema = await queryInterface.describeTable(TABLE_NAME);

    const indexes = await queryInterface.showIndex(TABLE_NAME);
    const hasLikesIdx = indexes.some((idx) => idx.name === "idx_posts_likes_count");
    if (hasLikesIdx) {
      await queryInterface.removeIndex(TABLE_NAME, "idx_posts_likes_count");
    }

    const hasSavesIdx = indexes.some((idx) => idx.name === "idx_posts_saves_count");
    if (hasSavesIdx) {
      await queryInterface.removeIndex(TABLE_NAME, "idx_posts_saves_count");
    }

    if (schema.saves_count) {
      await queryInterface.removeColumn(TABLE_NAME, "saves_count");
    }

    if (schema.likes_count) {
      await queryInterface.removeColumn(TABLE_NAME, "likes_count");
    }
  },
};
