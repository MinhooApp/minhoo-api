#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = Math.max(
  100,
  Number(process.env.HASHTAG_BACKFILL_BATCH_SIZE ?? 1000) || 1000
);
const HASHTAG_MAX_PER_CONTENT = 20;
const HASHTAG_EXTRACT_REGEX = /(^|[^A-Za-z0-9_])#([A-Za-z0-9_]{2,50})/g;

const SOURCES = [
  {
    label: "post",
    contentType: "post",
    table: "posts",
    idColumn: "id",
    textColumn: "post",
    whereClause: "is_delete = 0",
  },
  {
    label: "reel",
    contentType: "reel",
    table: "reels",
    idColumn: "id",
    textColumn: "description",
    whereClause: "is_delete = 0",
  },
  {
    label: "comment",
    contentType: "comment",
    table: "comments",
    idColumn: "id",
    textColumn: "comment",
    whereClause: "is_delete = 0",
  },
  {
    label: "reel_comment",
    contentType: "reel_comment",
    table: "reel_comments",
    idColumn: "id",
    textColumn: "comment",
    whereClause: "is_delete = 0",
  },
];

const loadEnv = () => {
  dotenv.config();
  const envFile = String(process.env.ENV_FILE || "").trim();
  if (envFile) {
    dotenv.config({
      path: path.resolve(ROOT_DIR, envFile),
      override: true,
    });
  }
  applyFileBackedSecrets(process.env, {
    forceOverride: false,
    baseDir: ROOT_DIR,
  });
};

const dbConfig = () => {
  const host = String(process.env.DB_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const user = String(process.env.USER_DB || process.env.DB_USER || "").trim();
  const password = String(process.env.DB_PASSWORD || "").trim();
  const database = String(process.env.DB || "").trim();
  const port = Number(process.env.DB_PORT || 3306) || 3306;

  if (!user || !database) {
    throw new Error("Missing DB config (USER_DB/DB).");
  }
  return {
    host,
    user,
    password,
    database,
    port,
    timezone: "Z",
  };
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const extractHashtags = (textRaw) => {
  const text = String(textRaw ?? "");
  if (!text) return [];

  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(HASHTAG_EXTRACT_REGEX)) {
    const token = String(match?.[2] ?? "")
      .trim()
      .toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= HASHTAG_MAX_PER_CONTENT) break;
  }
  return out;
};

const loadHashtagMap = async (conn) => {
  const map = new Map();
  const [rows] = await conn.query("SELECT id, tag FROM hashtags");
  for (const row of rows || []) {
    const id = Number(row.id);
    const tag = String(row.tag || "").trim().toLowerCase();
    if (id > 0 && tag) map.set(tag, id);
  }
  return map;
};

const ensureTags = async (conn, tags, hashtagMap) => {
  const uniqueTags = Array.from(
    new Set((Array.isArray(tags) ? tags : []).map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))
  );
  if (!uniqueTags.length) return;

  const missing = uniqueTags.filter((tag) => !hashtagMap.has(tag));
  if (!missing.length) return;

  for (const batch of chunk(missing, 300)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => "(?, UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(",");
    const values = batch.flatMap((tag) => [tag]);
    await conn.query(
      `INSERT IGNORE INTO hashtags (tag, createdAt, updatedAt) VALUES ${placeholders}`,
      values
    );
  }

  for (const batch of chunk(missing, 500)) {
    if (!batch.length) continue;
    const placeholders = batch.map(() => "?").join(",");
    const [rows] = await conn.query(
      `SELECT id, tag FROM hashtags WHERE tag IN (${placeholders})`,
      batch
    );
    for (const row of rows || []) {
      const id = Number(row.id);
      const tag = String(row.tag || "").trim().toLowerCase();
      if (id > 0 && tag) hashtagMap.set(tag, id);
    }
  }
};

const insertMappings = async (conn, mappings) => {
  if (!mappings.length) return 0;
  let insertedApprox = 0;
  for (const batch of chunk(mappings, 800)) {
    const placeholders = batch.map(() => "(?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(",");
    const values = batch.flatMap((row) => [
      row.hashtagId,
      row.contentType,
      row.contentId,
      row.sortOrder,
    ]);
    await conn.query(
      `INSERT IGNORE INTO content_hashtags (hashtagId, content_type, content_id, sort_order, createdAt, updatedAt) VALUES ${placeholders}`,
      values
    );
    insertedApprox += batch.length;
  }
  return insertedApprox;
};

const processSource = async (conn, source, hashtagMap) => {
  let lastId = 0;
  let rowsScanned = 0;
  let rowsWithHashtags = 0;
  let mappingsPrepared = 0;
  let insertedApprox = 0;
  const uniqueTagsSeen = new Set();

  while (true) {
    const [rows] = await conn.query(
      `
        SELECT ${source.idColumn} AS id, ${source.textColumn} AS text
        FROM ${source.table}
        WHERE ${source.idColumn} > ?
          AND ${source.whereClause}
        ORDER BY ${source.idColumn} ASC
        LIMIT ${BATCH_SIZE}
      `,
      [lastId]
    );
    if (!rows || rows.length === 0) break;

    rowsScanned += rows.length;
    lastId = Number(rows[rows.length - 1].id) || lastId;

    const mappings = [];
    const tagsToEnsure = [];
    for (const row of rows) {
      const contentId = Number(row.id);
      if (!Number.isFinite(contentId) || contentId <= 0) continue;
      const tags = extractHashtags(row.text);
      if (!tags.length) continue;

      rowsWithHashtags += 1;
      tags.forEach((tag) => {
        uniqueTagsSeen.add(tag);
        tagsToEnsure.push(tag);
      });
    }

    await ensureTags(conn, tagsToEnsure, hashtagMap);

    for (const row of rows) {
      const contentId = Number(row.id);
      if (!Number.isFinite(contentId) || contentId <= 0) continue;
      const tags = extractHashtags(row.text);
      if (!tags.length) continue;
      tags.forEach((tag, index) => {
        const hashtagId = hashtagMap.get(tag);
        if (!hashtagId) return;
        mappings.push({
          hashtagId,
          contentType: source.contentType,
          contentId,
          sortOrder: index,
        });
      });
    }

    mappingsPrepared += mappings.length;
    if (APPLY && mappings.length) {
      insertedApprox += await insertMappings(conn, mappings);
    }
  }

  return {
    label: source.label,
    contentType: source.contentType,
    rowsScanned,
    rowsWithHashtags,
    uniqueTags: uniqueTagsSeen.size,
    mappingsPrepared,
    mappingsInsertedApprox: insertedApprox,
  };
};

const main = async () => {
  loadEnv();
  const conn = await mysql.createConnection(dbConfig());
  const startedAt = Date.now();

  try {
    const [beforeRows] = await conn.query(
      "SELECT COUNT(*) AS hashtags_count FROM hashtags"
    );
    const [beforeLinks] = await conn.query(
      "SELECT COUNT(*) AS links_count FROM content_hashtags"
    );
    const hashtagsBefore = Number(beforeRows?.[0]?.hashtags_count || 0);
    const linksBefore = Number(beforeLinks?.[0]?.links_count || 0);

    if (APPLY) {
      await conn.query(
        "DELETE FROM content_hashtags WHERE content_type IN ('post','reel','comment','reel_comment')"
      );
    }

    const hashtagMap = await loadHashtagMap(conn);
    const sourceSummaries = [];

    for (const source of SOURCES) {
      const summary = await processSource(conn, source, hashtagMap);
      sourceSummaries.push(summary);
      console.log(
        `[${source.label}] scanned=${summary.rowsScanned} with_hashtags=${summary.rowsWithHashtags} mappings=${summary.mappingsPrepared} inserted≈${summary.mappingsInsertedApprox}`
      );
    }

    const [afterRows] = await conn.query("SELECT COUNT(*) AS hashtags_count FROM hashtags");
    const [afterLinks] = await conn.query(
      "SELECT COUNT(*) AS links_count FROM content_hashtags"
    );
    const hashtagsAfter = Number(afterRows?.[0]?.hashtags_count || 0);
    const linksAfter = Number(afterLinks?.[0]?.links_count || 0);

    const elapsedMs = Date.now() - startedAt;
    console.log("");
    console.log(`mode=${APPLY ? "apply" : "dry-run"} elapsed_ms=${elapsedMs}`);
    console.log(`hashtags_before=${hashtagsBefore} hashtags_after=${hashtagsAfter}`);
    console.log(`links_before=${linksBefore} links_after=${linksAfter}`);
    console.log(
      `sources=${sourceSummaries
        .map((s) => `${s.label}:${s.rowsWithHashtags}`)
        .join(",")}`
    );

    if (!APPLY) {
      console.log("dry-run complete. Re-run with --apply to persist.");
    }
  } finally {
    await conn.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
