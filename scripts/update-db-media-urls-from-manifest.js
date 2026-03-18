#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(process.cwd(), ".env") });

const manifestPathArg = process.argv.find((arg) => arg.startsWith("--manifest="));
const MANIFEST_PATH = manifestPathArg
  ? manifestPathArg.split("=")[1]
  : path.join(process.cwd(), "tmp-cloudflare-bulk-images-manifest-latest.json");

const APPLY = process.argv.includes("--apply");

const DB_HOST = String(process.env.DB_HOST || "127.0.0.1").trim();
const DB_USER = String(process.env.USER_DB || "").trim();
const DB_PASSWORD = String(process.env.DB_PASSWORD || "").trim();
const DB_NAME = String(process.env.DB || "").trim();

const TABLES = [
  { table: "users", id: "id", column: "image_profil" },
  { table: "mediapost", id: "id", column: "url" },
  { table: "comments", id: "id", column: "media_url" },
];

const toWebPath = (raw) => {
  if (!raw) return null;
  const v = String(raw).trim().replace(/\\/g, "/");
  if (!v) return null;
  if (/^https?:\/\//i.test(v) || v.startsWith("data:")) return null;

  if (v.startsWith("src/public/uploads/")) {
    const relative = v.slice("src/public".length).replace(/\/+/g, "/");
    return relative.startsWith("/") ? relative : `/${relative}`;
  }
  if (v.startsWith("/uploads/")) return v;
  if (v.startsWith("uploads/")) return `/${v}`;
  const idx = v.indexOf("/uploads/");
  if (idx >= 0) return v.slice(idx);
  return null;
};

const isLocalRaw = (raw) => {
  if (raw === null || raw === undefined) return false;
  const v = String(raw).trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v) || v.startsWith("data:")) return false;
  return (
    v.includes("\\") ||
    v.startsWith("/uploads/") ||
    v.startsWith("uploads/") ||
    v.startsWith("src/public/uploads/")
  );
};

const buildManifestMap = (manifestJson) => {
  const map = new Map();
  const rows = Array.isArray(manifestJson?.manifest) ? manifestJson.manifest : [];
  rows.forEach((row) => {
    if (!row?.uploaded || !row?.url || !row?.source) return;
    const source = String(row.source).replace(/\\/g, "/");
    const webPath = toWebPath(source);
    if (webPath) map.set(webPath, String(row.url));
  });
  return map;
};

const main = async () => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  if (!DB_USER || !DB_NAME) {
    throw new Error("Missing DB env vars USER_DB/DB");
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const map = buildManifestMap(manifest);
  if (!map.size) {
    throw new Error("Manifest has no uploaded rows to map");
  }

  const conn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  const summary = [];
  const missing = [];

  try {
    for (const cfg of TABLES) {
      const [rows] = await conn.execute(
        `SELECT ${cfg.id} AS id, ${cfg.column} AS value FROM ${cfg.table} WHERE ${cfg.column} IS NOT NULL AND ${cfg.column} <> ''`
      );

      let scanned = 0;
      let local = 0;
      let matched = 0;
      let updated = 0;

      for (const row of rows) {
        scanned += 1;
        const raw = row.value;
        if (!isLocalRaw(raw)) continue;
        local += 1;

        const webPath = toWebPath(raw);
        if (!webPath) continue;
        const remoteUrl = map.get(webPath);
        if (!remoteUrl) {
          missing.push({
            table: cfg.table,
            column: cfg.column,
            id: Number(row.id),
            value: String(raw),
            normalized: webPath,
          });
          continue;
        }
        matched += 1;
        if (APPLY) {
          await conn.execute(
            `UPDATE ${cfg.table} SET ${cfg.column} = ? WHERE ${cfg.id} = ?`,
            [remoteUrl, row.id]
          );
          updated += 1;
        }
      }

      summary.push({ table: cfg.table, scanned, local, matched, updated });
    }
  } finally {
    await conn.end();
  }

  console.log(`manifest_map_size=${map.size}`);
  summary.forEach((s) => {
    console.log(
      `${s.table}: scanned=${s.scanned} local=${s.local} matched=${s.matched} updated=${s.updated}`
    );
  });
  console.log(`missing=${missing.length}`);

  if (missing.length) {
    const reportPath = path.join(process.cwd(), "tmp-db-media-update-missing.json");
    fs.writeFileSync(reportPath, JSON.stringify(missing, null, 2));
    console.log(`missing_report=${reportPath}`);
  }

  if (!APPLY) {
    console.log("Dry-run only. Use --apply to update DB.");
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
