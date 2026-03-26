"use strict";

const normalizeTableName = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    if (typeof entry.tableName === "string") return entry.tableName;
    if (typeof entry.TABLE_NAME === "string") return entry.TABLE_NAME;
  }
  return "";
};

const INDEX_DEFINITIONS = [
  // Posts feed / summary
  {
    table: "posts",
    name: "idx_posts_feed_recent_visible",
    fields: ["is_delete", "created_date", "id"],
  },
  {
    table: "posts",
    name: "idx_posts_feed_user_visible_recent",
    fields: ["is_delete", "userId", "created_date", "id"],
  },
  {
    table: "posts",
    name: "idx_posts_feed_category_visible_recent",
    fields: ["is_delete", "categoryId", "created_date", "id"],
  },
  {
    table: "posts",
    name: "idx_posts_feed_trending_visible",
    fields: ["is_delete", "shares_count", "saves_count", "likes_count", "created_date", "id"],
  },

  // Comments / media / likes hydration
  {
    table: "comments",
    name: "idx_comments_post_visible_created",
    fields: ["postId", "is_delete", "created_date"],
  },
  {
    table: "mediapost",
    name: "idx_mediapost_post_isimg",
    fields: ["postId", "is_img"],
  },
  {
    table: "likes",
    name: "idx_likes_post_user",
    fields: ["postId", "userId"],
  },
  {
    table: "likes",
    name: "idx_likes_user_post",
    fields: ["userId", "postId"],
  },

  // Services / offers
  {
    table: "services",
    name: "idx_services_available_status_date",
    fields: ["is_available", "statusId", "service_date", "id"],
  },
  {
    table: "services",
    name: "idx_services_user_status_date",
    fields: ["userId", "statusId", "service_date", "id"],
  },
  {
    table: "offers",
    name: "idx_offers_service_offerdate",
    fields: ["serviceId", "offer_date", "id"],
  },
  {
    table: "offers",
    name: "idx_offers_service_flags_worker",
    fields: ["serviceId", "accepted", "canceled", "removed", "workerId"],
  },
  {
    table: "offers",
    name: "idx_offers_worker_flags_service",
    fields: ["workerId", "accepted", "canceled", "removed", "serviceId"],
  },

  // Reels feed / summary
  {
    table: "reels",
    name: "idx_reels_feed_visible_recent",
    fields: ["is_delete", "status", "visibility", "createdAt", "id"],
  },
  {
    table: "reels",
    name: "idx_reels_feed_user_recent",
    fields: ["is_delete", "status", "userId", "createdAt", "id"],
  },
  {
    table: "reels",
    name: "idx_reels_feed_trending",
    fields: [
      "is_delete",
      "status",
      "shares_count",
      "saves_count",
      "likes_count",
      "comments_count",
      "views_count",
      "createdAt",
      "id",
    ],
  },
  {
    table: "reel_comments",
    name: "idx_reel_comments_reel_visible_created",
    fields: ["reelId", "is_delete", "createdAt"],
  },
  {
    table: "reel_views",
    name: "idx_reel_views_user_recent",
    fields: ["userId", "viewed_date", "reelId"],
  },
  {
    table: "reel_views",
    name: "idx_reel_views_session_recent",
    fields: ["session_key", "viewed_date", "reelId"],
  },

  // Saved / followers access paths
  {
    table: "saved_posts",
    name: "idx_saved_posts_post",
    fields: ["postId"],
  },
  {
    table: "followers",
    name: "idx_followers_follower_user",
    fields: ["followerId", "userId"],
  },
];

const tableExists = async (queryInterface, tableName) => {
  const tablesRaw = await queryInterface.showAllTables();
  const tables = (tablesRaw || []).map(normalizeTableName).filter(Boolean);
  return tables.includes(tableName);
};

const getIndexNames = async (queryInterface, tableName) => {
  const indexes = await queryInterface.showIndex(tableName);
  return new Set((indexes || []).map((idx) => String(idx?.name ?? "").trim()).filter(Boolean));
};

const hasAllColumns = (schema, fields) => {
  if (!schema || typeof schema !== "object") return false;
  return fields.every((field) => Object.prototype.hasOwnProperty.call(schema, field));
};

const ensureIndex = async (queryInterface, definition) => {
  const exists = await tableExists(queryInterface, definition.table);
  if (!exists) return;

  const schema = await queryInterface.describeTable(definition.table);
  if (!hasAllColumns(schema, definition.fields)) return;

  const indexNames = await getIndexNames(queryInterface, definition.table);
  if (indexNames.has(definition.name)) return;

  await queryInterface.addIndex(definition.table, definition.fields, {
    name: definition.name,
  });
};

const dropIndexIfExists = async (queryInterface, definition) => {
  const exists = await tableExists(queryInterface, definition.table);
  if (!exists) return;

  const indexNames = await getIndexNames(queryInterface, definition.table);
  if (!indexNames.has(definition.name)) return;
  await queryInterface.removeIndex(definition.table, definition.name);
};

module.exports = {
  async up(queryInterface) {
    for (const definition of INDEX_DEFINITIONS) {
      // Intentionally sequential to reduce lock contention on busy tables.
      // eslint-disable-next-line no-await-in-loop
      await ensureIndex(queryInterface, definition);
    }
  },

  async down(queryInterface) {
    for (const definition of INDEX_DEFINITIONS) {
      // eslint-disable-next-line no-await-in-loop
      await dropIndexIfExists(queryInterface, definition);
    }
  },
};
