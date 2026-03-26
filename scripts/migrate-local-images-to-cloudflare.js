#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

dotenv.config({ path: path.join(process.cwd(), ".env") });
applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: process.cwd() });

const APPLY = process.argv.includes("--apply");
const VARIANT = String(process.env.CLOUDFLARE_IMAGES_VARIANT || "public").trim() || "public";
const ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const API_TOKEN = String(
  process.env.CLOUDFLARE_IMAGES_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_TOKEN ||
    ""
).trim();

const DB_HOST = String(process.env.DB_HOST || "127.0.0.1").trim();
const DB_USER = String(process.env.USER_DB || "").trim();
const DB_PASSWORD = String(process.env.DB_PASSWORD || "").trim();
const DB_NAME = String(process.env.DB || "").trim();

const API_BASE = "https://api.cloudflare.com/client/v4";
const PUBLIC_ROOT = path.join(process.cwd(), "src", "public");

const LOCAL_WHERE =
  "(%COL% LIKE '/uploads/%' OR %COL% LIKE '\\\\uploads\\\\%' OR %COL% LIKE 'src/public/uploads/%' OR %COL% LIKE 'uploads/%')";

const TABLES = [
  { table: "users", id: "id", column: "image_profil" },
  { table: "mediapost", id: "id", column: "url" },
  { table: "comments", id: "id", column: "media_url" },
];

const toWebPath = (raw) => {
  if (!raw) return null;
  const value = String(raw).trim().replace(/\\/g, "/");
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return null;

  if (value.startsWith("src/public/uploads/")) {
    const relative = value.slice("src/public".length).replace(/\/+/g, "/");
    return relative.startsWith("/") ? relative : `/${relative}`;
  }
  if (value.startsWith("/uploads/")) return value;
  if (value.startsWith("uploads/")) return `/${value}`;
  const idx = value.indexOf("/uploads/");
  if (idx >= 0) return value.slice(idx);
  return null;
};

const toAbsolutePath = (webPath) => {
  if (!webPath || !webPath.startsWith("/uploads/")) return null;
  const rel = webPath.slice(1);
  return path.join(PUBLIC_ROOT, rel);
};

const pickVariantUrl = (result) => {
  const variants = Array.isArray(result?.variants) ? result.variants : [];
  const preferred = variants.find((u) => String(u).endsWith(`/${VARIANT}`));
  return preferred || variants[0] || null;
};

const uploadToCloudflare = async (filePath) => {
  const formData = new FormData();
  formData.append("requireSignedURLs", "false");
  formData.append("metadata", JSON.stringify({ app: "minhoo", migrated: true }));
  formData.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));

  const response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}/images/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: formData,
  });

  const payload = await response.json();
  if (!payload?.success) {
    const msg =
      payload?.errors?.map((e) => e?.message).filter(Boolean).join(" | ") ||
      payload?.messages?.map((e) => e?.message || e).filter(Boolean).join(" | ") ||
      `cloudflare upload failed (${response.status})`;
    throw new Error(msg);
  }

  const url = pickVariantUrl(payload.result);
  if (!url) throw new Error("cloudflare upload returned no variant url");
  return url;
};

const main = async () => {
  if (!ACCOUNT_ID || !API_TOKEN) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_IMAGES_API_TOKEN");
  }
  if (!DB_USER || !DB_NAME) {
    throw new Error("Missing DB env vars USER_DB/DB");
  }

  const conn = await mysql.createConnection({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    const targets = [];
    for (const cfg of TABLES) {
      const where = LOCAL_WHERE.replaceAll("%COL%", cfg.column);
      const [rows] = await conn.execute(
        `SELECT ${cfg.id} AS id, ${cfg.column} AS value FROM ${cfg.table} WHERE ${cfg.column} IS NOT NULL AND ${cfg.column} <> '' AND ${where}`
      );
      for (const row of rows) {
        targets.push({
          table: cfg.table,
          idColumn: cfg.id,
          valueColumn: cfg.column,
          id: Number(row.id),
          currentValue: String(row.value || ""),
        });
      }
    }

    const normalized = targets
      .map((t) => {
        const webPath = toWebPath(t.currentValue);
        const absPath = toAbsolutePath(webPath);
        return { ...t, webPath, absPath };
      })
      .filter((t) => !!t.webPath);

    const existing = normalized.filter((t) => t.absPath && fs.existsSync(t.absPath));
    const missing = normalized.filter((t) => !t.absPath || !fs.existsSync(t.absPath));

    console.log(`Targets found: ${targets.length}`);
    console.log(`Normalized local references: ${normalized.length}`);
    console.log(`Existing local files: ${existing.length}`);
    console.log(`Missing local files: ${missing.length}`);
    if (missing.length) {
      console.log("Missing examples:");
      missing.slice(0, 10).forEach((m) => {
        console.log(`- ${m.table}.${m.valueColumn} id=${m.id} value=${m.currentValue}`);
      });
    }

    if (!APPLY) {
      console.log("Dry-run only. Re-run with --apply to upload and update DB.");
      return;
    }

    const uploadedByPath = new Map();
    const errors = [];
    let updated = 0;

    for (const row of existing) {
      try {
        let url = uploadedByPath.get(row.absPath);
        if (!url) {
          url = await uploadToCloudflare(row.absPath);
          uploadedByPath.set(row.absPath, url);
        }

        await conn.execute(
          `UPDATE ${row.table} SET ${row.valueColumn} = ? WHERE ${row.idColumn} = ?`,
          [url, row.id]
        );
        updated += 1;
        console.log(`updated ${row.table}.${row.valueColumn} id=${row.id}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          table: row.table,
          id: row.id,
          value: row.currentValue,
          error: message,
        });
        console.log(`ERROR ${row.table}.${row.valueColumn} id=${row.id}: ${message}`);
      }
    }

    console.log(`Upload files unique: ${uploadedByPath.size}`);
    console.log(`Rows updated: ${updated}`);
    console.log(`Errors: ${errors.length}`);
    if (errors.length) {
      const report = path.join(process.cwd(), "tmp-cloudflare-migration-errors.json");
      fs.writeFileSync(report, JSON.stringify(errors, null, 2));
      console.log(`Error report: ${report}`);
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
