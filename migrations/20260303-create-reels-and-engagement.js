"use strict";

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

    if (!tables.includes("reels")) {
      await queryInterface.createTable("reels", {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        video_uid: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        stream_url: {
          type: Sequelize.STRING(512),
          allowNull: false,
        },
        download_url: {
          type: Sequelize.STRING(512),
          allowNull: true,
        },
        thumbnail_url: {
          type: Sequelize.STRING(512),
          allowNull: true,
        },
        duration_seconds: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        visibility: {
          type: Sequelize.ENUM("public", "followers", "private"),
          allowNull: false,
          defaultValue: "public",
        },
        status: {
          type: Sequelize.ENUM("processing", "ready", "failed"),
          allowNull: false,
          defaultValue: "ready",
        },
        allow_download: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        metadata: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        views_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        likes_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        comments_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        shares_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        saves_count: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        is_delete: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        deleted_date: {
          type: Sequelize.DATE,
          allowNull: true,
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

      await queryInterface.addIndex("reels", ["userId", "createdAt"], {
        name: "idx_reels_user_created",
      });
      await queryInterface.addIndex("reels", ["visibility", "createdAt"], {
        name: "idx_reels_visibility_created",
      });
      await queryInterface.addIndex("reels", ["video_uid"], {
        name: "idx_reels_video_uid",
      });
    }

    if (!tables.includes("reel_likes")) {
      await queryInterface.createTable("reel_likes", {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        reelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "reels", key: "id" },
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
      await queryInterface.addIndex("reel_likes", ["userId", "reelId"], {
        unique: true,
        name: "uniq_reel_like_user",
      });
      await queryInterface.addIndex("reel_likes", ["reelId", "createdAt"], {
        name: "idx_reel_likes_reel",
      });
    }

    if (!tables.includes("reel_saves")) {
      await queryInterface.createTable("reel_saves", {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        reelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "reels", key: "id" },
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
      await queryInterface.addIndex("reel_saves", ["userId", "reelId"], {
        unique: true,
        name: "uniq_reel_save_user",
      });
      await queryInterface.addIndex("reel_saves", ["userId", "createdAt"], {
        name: "idx_reel_saves_user_created",
      });
    }

    if (!tables.includes("reel_comments")) {
      await queryInterface.createTable("reel_comments", {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        reelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "reels", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        comment: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        media_url: {
          type: Sequelize.STRING(512),
          allowNull: true,
        },
        is_delete: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        deleted_date: {
          type: Sequelize.DATE,
          allowNull: true,
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
      await queryInterface.addIndex("reel_comments", ["reelId", "createdAt"], {
        name: "idx_reel_comments_reel_created",
      });
      await queryInterface.addIndex("reel_comments", ["userId", "createdAt"], {
        name: "idx_reel_comments_user_created",
      });
    }

    if (!tables.includes("reel_views")) {
      await queryInterface.createTable("reel_views", {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        reelId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: "reels", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: "users", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
        },
        session_key: {
          type: Sequelize.STRING(128),
          allowNull: true,
        },
        viewed_date: {
          type: Sequelize.DATEONLY,
          allowNull: false,
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
      await queryInterface.addIndex(
        "reel_views",
        ["reelId", "userId", "viewed_date"],
        {
          unique: true,
          name: "uniq_reel_view_user_day",
        }
      );
      await queryInterface.addIndex(
        "reel_views",
        ["reelId", "session_key", "viewed_date"],
        {
          unique: true,
          name: "uniq_reel_view_session_day",
        }
      );
      await queryInterface.addIndex("reel_views", ["reelId", "viewed_date"], {
        name: "idx_reel_views_reel_day",
      });
    }
  },

  async down(queryInterface) {
    const tablesRaw = await queryInterface.showAllTables();
    const tables = (tablesRaw || []).map(normalizeTableName).filter(Boolean);

    if (tables.includes("reel_views")) await queryInterface.dropTable("reel_views");
    if (tables.includes("reel_comments")) await queryInterface.dropTable("reel_comments");
    if (tables.includes("reel_saves")) await queryInterface.dropTable("reel_saves");
    if (tables.includes("reel_likes")) await queryInterface.dropTable("reel_likes");
    if (tables.includes("reels")) await queryInterface.dropTable("reels");

    await queryInterface.sequelize.query(
      "DROP TYPE IF EXISTS enum_reels_visibility;"
    ).catch(() => {});
    await queryInterface.sequelize.query(
      "DROP TYPE IF EXISTS enum_reels_status;"
    ).catch(() => {});
  },
};
