#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".mp4",
  ".mov",
  ".avi",
  ".zip",
  ".jar",
  ".class",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

const SKIP_PATH_PREFIXES = ["node_modules/", "dist/", ".git/", "src/public/uploads/", ".secrets/"];

const DETECTORS = [
  {
    id: "github_pat",
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "aws_access_key_id",
    regex: /\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "telegram_bot_token",
    regex: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    id: "private_key_block",
    regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/g,
  },
  {
    id: "openai_key_like",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
];

const ALLOW_LINE = /CHANGE_ME|<set\s+FIREBASE_|placeholder|dummy|example|xxxx|YOUR_|__USE_DB_PASSWORD_FILE__|\.\.\./i;

const walkFiles = (dirPath, relativeBase = "") => {
  const output = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    console.warn(
      `[secret-scan][warn] skip directory ${relativeBase || "."}: ${String(error?.message || error)}`
    );
    return output;
  }
  for (const entry of entries) {
    const rel = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
    const full = path.join(dirPath, entry.name);
    const normalizedRel = rel.replace(/\\/g, "/");

    if (shouldSkipPath(normalizedRel, entry.isDirectory())) continue;

    if (entry.isDirectory()) {
      output.push(...walkFiles(full, normalizedRel));
      continue;
    }
    if (entry.isFile()) output.push(normalizedRel);
  }
  return output;
};

const shouldSkipPath = (relativePath, isDirectory = false) => {
  if (!relativePath) return true;
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (relativePath.startsWith(prefix)) return true;
  }
  const base = path.basename(relativePath);
  if (base === ".env" || base === ".env.green" || /^\.env\..+/.test(base)) return true;
  if (isDirectory) return false;
  const ext = path.extname(relativePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return true;
  return false;
};

const scanFile = (relativePath, findings) => {
  const fullPath = path.join(ROOT, relativePath);
  const stat = fs.statSync(fullPath);
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) return;

  const content = fs.readFileSync(fullPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || ALLOW_LINE.test(line)) continue;

    for (const detector of DETECTORS) {
      detector.regex.lastIndex = 0;
      const match = detector.regex.exec(line);
      if (!match) continue;
      findings.push({
        file: relativePath,
        line: index + 1,
        detector: detector.id,
        snippet: line.trim().slice(0, 180),
      });
    }
  }
};

const run = () => {
  const trackedFiles = walkFiles(ROOT);
  const findings = [];

  for (const file of trackedFiles) {
    if (shouldSkipPath(file)) continue;
    try {
      scanFile(file, findings);
    } catch (error) {
      console.warn(`[secret-scan][warn] skip ${file}: ${String(error?.message || error)}`);
    }
  }

  if (findings.length === 0) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          checked_files: trackedFiles.length,
          findings: 0,
          message: "No high-confidence secret patterns found in tracked files.",
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: false,
        checked_files: trackedFiles.length,
        findings: findings.length,
        entries: findings,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
};

run();
