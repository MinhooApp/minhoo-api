#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const MYSQL_BIN = process.env.MYSQL_BIN || "mysql";
const SAFE_DELETE_STATES = new Set(["pendingupload", "error"]);
const UID_PATTERNS = [
  /uid=([A-Za-z0-9]+)/i,
  /videodelivery\.net\/([A-Za-z0-9]+)/i,
  /cloudflarestream\.com\/([A-Za-z0-9]+)/i,
];

const args = new Set(process.argv.slice(2));
const shouldDelete = args.has("--delete");
const asJson = args.has("--json");
const includeOrphanReady = args.has("--include-orphan-ready");

const loadEnvFile = (filePath) => {
  const env = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  }
  return env;
};

const envFile = loadEnvFile(ENV_PATH);
const accountId = String(envFile.CLOUDFLARE_ACCOUNT_ID || "").trim();
const mediaToken = String(envFile.CLOUDFLARE_MEDIA_API_TOKEN || envFile.CLOUDFLARE_API_TOKEN || envFile.CLOUDFLARE_TOKEN || "").trim();

if (!accountId) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is not configured");
}

if (!mediaToken) {
  throw new Error("CLOUDFLARE_MEDIA_API_TOKEN is not configured");
}

const mysqlConfig = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  user: process.env.MYSQL_USER || "minhoo_user",
  password: process.env.MYSQL_PASSWORD || "Minhoo@2026!",
  database: process.env.MYSQL_DATABASE || "mnh_db",
};

const cloudflareHeaders = {
  Authorization: `Bearer ${mediaToken}`,
  "Content-Type": "application/json",
};

const requestCloudflareJson = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...cloudflareHeaders,
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  return { response, payload };
};

const runMysql = (query) => {
  const output = execFileSync(
    MYSQL_BIN,
    [
      "-h",
      mysqlConfig.host,
      "-u",
      mysqlConfig.user,
      `-p${mysqlConfig.password}`,
      "-D",
      mysqlConfig.database,
      "-N",
      "-B",
      "-e",
      query,
    ],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  return output;
};

const extractUid = (rawValue) => {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  for (const pattern of UID_PATTERNS) {
    const match = value.match(pattern);
    if (match && match[1]) return match[1];
  }
  if (/^[A-Za-z0-9]{32}$/.test(value)) return value;
  return null;
};

const fetchAllStreamAssets = async () => {
  const results = [];
  let page = 1;

  while (true) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream?page=${page}&per_page=1000`;
    const { response, payload } = await requestCloudflareJson(url);
    if (!response.ok) {
      throw new Error(`Cloudflare stream list failed (${response.status})`);
    }
    if (!payload?.success) {
      const firstError = payload?.errors?.[0]?.message || "Cloudflare stream list failed";
      throw new Error(firstError);
    }

    const batch = Array.isArray(payload.result) ? payload.result : [];
    results.push(...batch);

    if (batch.length < 1000) break;
    page += 1;
  }

  return results;
};

const deleteStreamAsset = async (uid) => {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(uid)}`;
  const { response, payload } = await requestCloudflareJson(url, {
    method: "DELETE",
  });

  if (response.ok && payload?.success) {
    return { deleted: true, notFound: false, payload };
  }

  const firstCode = payload?.errors?.[0]?.code;
  const firstError = payload?.errors?.[0]?.message || `Cloudflare stream delete failed (${response.status})`;
  if (Number(firstCode) === 10003) {
    return { deleted: false, notFound: true, payload };
  }

  throw new Error(firstError);
};

const buildDbReferenceMap = () => {
  const query = `
SELECT 'reels' AS src, CAST(id AS CHAR) AS ref_id, COALESCE(video_uid,'') AS val
FROM reels
WHERE video_uid IS NOT NULL AND video_uid <> ''
UNION ALL
SELECT 'messages' AS src, CAST(id AS CHAR) AS ref_id, COALESCE(mediaUrl,'') AS val
FROM messages
WHERE mediaUrl LIKE '/api/v1/media/video/play?uid=%'
UNION ALL
SELECT 'mediapost' AS src, CAST(id AS CHAR) AS ref_id, COALESCE(url,'') AS val
FROM mediapost
WHERE url LIKE '%uid=%'
   OR url LIKE '%videodelivery.net/%'
   OR url LIKE '%cloudflarestream.com/%';
`;

  const output = runMysql(query);
  const refs = new Map();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [src, refId, rawValue] = line.split("\t");
    const uid = src === "reels" ? String(rawValue || "").trim() : extractUid(rawValue);
    if (!uid) continue;

    const current = refs.get(uid) || [];
    current.push({
      src,
      refId,
      rawValue,
    });
    refs.set(uid, current);
  }

  return refs;
};

const incrementCounter = (bucket, key) => {
  bucket[key] = (bucket[key] || 0) + 1;
};

const toMb = (bytes) => Number((Number(bytes || 0) / (1024 * 1024)).toFixed(2));

const formatSummary = (assets, refs) => {
  const summary = {
    streamTotal: assets.length,
    referencedAssets: 0,
    orphanAssets: 0,
    safeDeleteCandidates: 0,
    byState: {},
    byContext: {},
    safeDeleteByState: {},
    safeDeleteByContext: {},
    totalSizeMb: 0,
    safeDeleteSizeMb: 0,
    candidates: [],
    orphanReady: [],
  };

  let totalBytes = 0;
  let safeDeleteBytes = 0;

  for (const asset of assets) {
    const uid = String(asset?.uid || "").trim();
    const state = String(asset?.status?.state || "unknown").trim().toLowerCase();
    const context = String(asset?.meta?.context || "unknown").trim().toLowerCase();
    const size = Number(asset?.size || 0);
    const references = refs.get(uid) || [];
    const entry = {
      uid,
      state,
      context,
      size,
      sizeMb: toMb(size),
      created: asset?.created || null,
      refs: references,
    };

    totalBytes += size;
    incrementCounter(summary.byState, state);
    incrementCounter(summary.byContext, context);

    if (references.length > 0) {
      summary.referencedAssets += 1;
      continue;
    }

    summary.orphanAssets += 1;

    if (SAFE_DELETE_STATES.has(state)) {
      summary.safeDeleteCandidates += 1;
      safeDeleteBytes += size;
      incrementCounter(summary.safeDeleteByState, state);
      incrementCounter(summary.safeDeleteByContext, context);
      summary.candidates.push(entry);
      continue;
    }

    if (includeOrphanReady) {
      summary.orphanReady.push(entry);
    }
  }

  summary.totalSizeMb = toMb(totalBytes);
  summary.safeDeleteSizeMb = toMb(safeDeleteBytes);
  return summary;
};

const printHumanSummary = (summary) => {
  console.log(`[cloudflare-stream] total_assets=${summary.streamTotal} total_size_mb=${summary.totalSizeMb}`);
  console.log(
    `[cloudflare-stream] referenced=${summary.referencedAssets} orphan=${summary.orphanAssets} safe_delete_candidates=${summary.safeDeleteCandidates} safe_delete_size_mb=${summary.safeDeleteSizeMb}`
  );
  console.log(`[cloudflare-stream] by_state=${JSON.stringify(summary.byState)}`);
  console.log(`[cloudflare-stream] by_context=${JSON.stringify(summary.byContext)}`);
  console.log(`[cloudflare-stream] safe_delete_by_state=${JSON.stringify(summary.safeDeleteByState)}`);
  console.log(`[cloudflare-stream] safe_delete_by_context=${JSON.stringify(summary.safeDeleteByContext)}`);

  if (summary.candidates.length > 0) {
    console.log("[cloudflare-stream] safe delete candidates:");
    for (const candidate of summary.candidates) {
      console.log(
        `- uid=${candidate.uid} state=${candidate.state} context=${candidate.context} size_mb=${candidate.sizeMb} created=${candidate.created}`
      );
    }
  }

  if (summary.orphanReady.length > 0) {
    console.log("[cloudflare-stream] orphan ready assets:");
    for (const asset of summary.orphanReady) {
      console.log(`- uid=${asset.uid} context=${asset.context} size_mb=${asset.sizeMb} created=${asset.created}`);
    }
  }
};

const main = async () => {
  const refs = buildDbReferenceMap();
  const assets = await fetchAllStreamAssets();
  const summary = formatSummary(assets, refs);

  if (shouldDelete && summary.candidates.length > 0) {
    const deleted = [];
    const notFound = [];
    const failed = [];

    for (const candidate of summary.candidates) {
      try {
        const result = await deleteStreamAsset(candidate.uid);
        if (result.deleted) {
          deleted.push(candidate.uid);
          continue;
        }

        if (result.notFound) {
          notFound.push(candidate.uid);
        }
      } catch (error) {
        failed.push({
          uid: candidate.uid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    summary.deleted = deleted;
    summary.ghostCandidates = notFound;
    summary.deleteFailed = failed;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  printHumanSummary(summary);

  if (shouldDelete) {
    const deletedCount = Array.isArray(summary.deleted) ? summary.deleted.length : 0;
    const ghostCount = Array.isArray(summary.ghostCandidates) ? summary.ghostCandidates.length : 0;
    const failedCount = Array.isArray(summary.deleteFailed) ? summary.deleteFailed.length : 0;
    console.log(`[cloudflare-stream] deleted=${deletedCount} ghost=${ghostCount} failed=${failedCount}`);
    if (ghostCount > 0) {
      for (const uid of summary.ghostCandidates) {
        console.log(`- ghost uid=${uid} not_resolvable_by_api=true`);
      }
    }
    if (failedCount > 0) {
      for (const item of summary.deleteFailed) {
        console.log(`- failed uid=${item.uid} error=${item.error}`);
      }
    }
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
