"use strict";

const HASHTAGS_TABLE = "hashtags";
const CONTENT_HASHTAGS_TABLE = "content_hashtags";

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
  return (indexes || []).some((index) => String(index?.name ?? "") === indexName);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const hashtagsExists = await tableExists(queryInterface, HASHTAGS_TABLE);
    if (!hashtagsExists) {
      await queryInterface.createTable(HASHTAGS_TABLE, {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        tag: {
          type: Sequelize.STRING(50),
          allowNull: false,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
          ),
        },
      });
    }

    if (!(await indexExists(queryInterface, HASHTAGS_TABLE, "uq_hashtags_tag"))) {
      await queryInterface.addIndex(HASHTAGS_TABLE, ["tag"], {
        name: "uq_hashtags_tag",
        unique: true,
      });
    }

    const contentHashtagsExists = await tableExists(
      queryInterface,
      CONTENT_HASHTAGS_TABLE
    );
    if (!contentHashtagsExists) {
      await queryInterface.createTable(CONTENT_HASHTAGS_TABLE, {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        hashtagId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: HASHTAGS_TABLE, key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        content_type: {
          type: Sequelize.STRING(20),
          allowNull: false,
        },
        content_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },
        sort_order: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal(
            "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
          ),
        },
      });
    }

    if (
      !(await indexExists(
        queryInterface,
        CONTENT_HASHTAGS_TABLE,
        "uq_content_hashtags_content_tag"
      ))
    ) {
      await queryInterface.addIndex(
        CONTENT_HASHTAGS_TABLE,
        ["content_type", "content_id", "hashtagId"],
        {
          name: "uq_content_hashtags_content_tag",
          unique: true,
        }
      );
    }

    if (
      !(await indexExists(
        queryInterface,
        CONTENT_HASHTAGS_TABLE,
        "idx_content_hashtags_tag_created"
      ))
    ) {
      await queryInterface.addIndex(
        CONTENT_HASHTAGS_TABLE,
        ["hashtagId", "createdAt", "id"],
        {
          name: "idx_content_hashtags_tag_created",
        }
      );
    }

    if (
      !(await indexExists(
        queryInterface,
        CONTENT_HASHTAGS_TABLE,
        "idx_content_hashtags_content_lookup"
      ))
    ) {
      await queryInterface.addIndex(
        CONTENT_HASHTAGS_TABLE,
        ["content_type", "content_id"],
        {
          name: "idx_content_hashtags_content_lookup",
        }
      );
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, CONTENT_HASHTAGS_TABLE)) {
      if (
        await indexExists(
          queryInterface,
          CONTENT_HASHTAGS_TABLE,
          "uq_content_hashtags_content_tag"
        )
      ) {
        await queryInterface.removeIndex(
          CONTENT_HASHTAGS_TABLE,
          "uq_content_hashtags_content_tag"
        );
      }
      if (
        await indexExists(
          queryInterface,
          CONTENT_HASHTAGS_TABLE,
          "idx_content_hashtags_tag_created"
        )
      ) {
        await queryInterface.removeIndex(
          CONTENT_HASHTAGS_TABLE,
          "idx_content_hashtags_tag_created"
        );
      }
      if (
        await indexExists(
          queryInterface,
          CONTENT_HASHTAGS_TABLE,
          "idx_content_hashtags_content_lookup"
        )
      ) {
        await queryInterface.removeIndex(
          CONTENT_HASHTAGS_TABLE,
          "idx_content_hashtags_content_lookup"
        );
      }
      await queryInterface.dropTable(CONTENT_HASHTAGS_TABLE);
    }

    if (await tableExists(queryInterface, HASHTAGS_TABLE)) {
      if (await indexExists(queryInterface, HASHTAGS_TABLE, "uq_hashtags_tag")) {
        await queryInterface.removeIndex(HASHTAGS_TABLE, "uq_hashtags_tag");
      }
      await queryInterface.dropTable(HASHTAGS_TABLE);
    }
  },
};
