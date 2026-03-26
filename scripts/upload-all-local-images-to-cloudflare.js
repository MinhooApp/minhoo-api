#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

dotenv.config({ path: path.join(process.cwd(), ".env") });
applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: process.cwd() });

const APPLY = process.argv.includes("--apply");
const DELETE_LOCAL = process.argv.includes("--delete-local");

const ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const TOKEN = String(
  process.env.CLOUDFLARE_IMAGES_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_TOKEN ||
    ""
).trim();
const VARIANT = String(process.env.CLOUDFLARE_IMAGES_VARIANT || "public").trim() || "public";
const API_BASE = "https://api.cloudflare.com/client/v4";

const ROOT = process.cwd();
const TARGET_DIRS = [
  path.join(ROOT, "src", "public", "uploads", "images", "user", "profile"),
  path.join(ROOT, "src", "public", "uploads", "images", "post"),
];

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".avif",
]);

const toMime = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  if (ext === ".avif") return "image/avif";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "application/octet-stream";
};

const fileSha256 = (filePath) => {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
};

const walkFiles = (dirPath) => {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(abs);
  }
  return out;
};

const pickVariantUrl = (result) => {
  const variants = Array.isArray(result?.variants) ? result.variants : [];
  const preferred = variants.find((url) => String(url).endsWith(`/${VARIANT}`));
  return preferred || variants[0] || null;
};

const uploadSingle = async (filePath, hash) => {
  const mime = toMime(filePath);
  const formData = new FormData();
  formData.append("requireSignedURLs", "false");
  formData.append(
    "metadata",
    JSON.stringify({
      app: "minhoo",
      migrated: true,
      hash,
      source: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    })
  );
  formData.append(
    "file",
    new Blob([fs.readFileSync(filePath)], { type: mime }),
    path.basename(filePath)
  );

  const response = await fetch(`${API_BASE}/accounts/${ACCOUNT_ID}/images/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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
  if (!url) throw new Error("cloudflare response has no variant URL");
  return { url, imageId: payload.result?.id || null };
};

const uploadWithRetry = async (filePath, hash, maxRetries = 3) => {
  let lastError = null;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      return await uploadSingle(filePath, hash);
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (i + 1)));
      }
    }
  }
  throw lastError || new Error("upload failed");
};

const main = async () => {
  if (!ACCOUNT_ID || !TOKEN) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_IMAGES_API_TOKEN");
  }

  const allFiles = TARGET_DIRS.flatMap((dir) => walkFiles(dir));
  const imageFiles = allFiles.filter((filePath) =>
    IMAGE_EXT.has(path.extname(filePath).toLowerCase())
  );

  console.log(`Files found in target folders: ${allFiles.length}`);
  console.log(`Image files to process: ${imageFiles.length}`);

  if (!imageFiles.length) {
    console.log("No image files found.");
    return;
  }

  const byHash = new Map();
  for (const filePath of imageFiles) {
    const hash = fileSha256(filePath);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(filePath);
  }

  console.log(`Unique image hashes: ${byHash.size}`);

  if (!APPLY) {
    console.log("Dry-run only. Use --apply to upload.");
    return;
  }

  const hashToUpload = new Map();
  const failed = [];
  let idx = 0;
  for (const [hash, files] of byHash.entries()) {
    idx += 1;
    const sampleFile = files[0];
    try {
      const uploaded = await uploadWithRetry(sampleFile, hash);
      hashToUpload.set(hash, uploaded);
      if (idx % 20 === 0 || idx === byHash.size) {
        console.log(`Uploaded ${idx}/${byHash.size} unique images`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({
        hash,
        sampleFile: path.relative(ROOT, sampleFile).replace(/\\/g, "/"),
        error: message,
      });
      console.log(`ERROR upload ${sampleFile}: ${message}`);
    }
  }

  const manifest = [];
  for (const filePath of imageFiles) {
    const hash = fileSha256(filePath);
    const uploaded = hashToUpload.get(hash);
    manifest.push({
      source: path.relative(ROOT, filePath).replace(/\\/g, "/"),
      hash,
      size_bytes: fs.statSync(filePath).size,
      uploaded: !!uploaded,
      image_id: uploaded?.imageId || null,
      url: uploaded?.url || null,
    });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(ROOT, `tmp-cloudflare-bulk-images-manifest-${ts}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        variant: VARIANT,
        apply: APPLY,
        delete_local: DELETE_LOCAL,
        files_total: imageFiles.length,
        unique_total: byHash.size,
        uploads_ok: hashToUpload.size,
        uploads_failed: failed.length,
        failed,
        manifest,
      },
      null,
      2
    )
  );

  console.log(`Manifest: ${reportPath}`);

  if (DELETE_LOCAL) {
    let deleted = 0;
    for (const row of manifest) {
      if (!row.uploaded) continue;
      const absPath = path.join(ROOT, row.source);
      if (!fs.existsSync(absPath)) continue;
      fs.unlinkSync(absPath);
      deleted += 1;
    }
    console.log(`Local files deleted: ${deleted}`);
  }

  console.log(`Uploads OK: ${hashToUpload.size}/${byHash.size} unique`);
  console.log(`Upload failures: ${failed.length}`);
  if (failed.length) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
