#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

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

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const toEpochMs = (value) => {
  const fromNumber = Number(value);
  if (Number.isFinite(fromNumber) && fromNumber > 0) return fromNumber;
  const fromDate = Date.parse(String(value || ""));
  if (Number.isFinite(fromDate) && fromDate > 0) return fromDate;
  return 0;
};

const pruneFile = ({ filePath, maxLines, retentionHours }) => {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return;

  const now = Date.now();
  const retentionMs = Math.max(1, retentionHours) * 60 * 60 * 1000;
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const kept = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const sampledAtMs = toEpochMs(parsed?.sampled_at || parsed?.payload?.at);
      if (sampledAtMs && now - sampledAtMs > retentionMs) continue;
      kept.push(line);
    } catch {
      // drop malformed lines
    }
  }

  const sliced =
    kept.length > maxLines ? kept.slice(Math.max(0, kept.length - maxLines)) : kept;
  fs.writeFileSync(filePath, `${sliced.join("\n")}${sliced.length ? "\n" : ""}`, "utf8");
};

const parseJson = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const main = () => {
  loadEnv();
  const strict = isTruthy(process.env.FEED_SLO_STRICT ?? "1");
  const failOnBreach = isTruthy(process.env.FEED_SLO_SAMPLE_FAIL_ON_BREACH ?? "0");
  const samplesFile = path.resolve(
    ROOT_DIR,
    String(process.env.FEED_SLO_24H_SAMPLES_FILE || "/tmp/minhoo-feed-slo-samples.jsonl")
  );
  const maxLines = toPositiveInt(process.env.FEED_SLO_24H_MAX_LINES, 12000);
  const retentionHours = toPositiveInt(process.env.FEED_SLO_24H_RETENTION_HOURS, 72);

  ensureDir(samplesFile);

  const args = [path.resolve(__dirname, "monitor-feed-slo.js"), "--json"];
  if (strict) args.push("--strict");

  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: process.env,
  });

  const payload = parseJson(result.stdout) || {
    ok: false,
    strict,
    at: new Date().toISOString(),
    parse_error: "monitor output was not valid JSON",
    stdout: String(result.stdout || "").trim().slice(0, 800),
    stderr: String(result.stderr || "").trim().slice(0, 800),
  };

  const record = {
    sampled_at: startedAt,
    monitor_exit_code: Number.isFinite(result.status) ? result.status : 1,
    payload,
  };

  fs.appendFileSync(samplesFile, `${JSON.stringify(record)}\n`, "utf8");
  pruneFile({
    filePath: samplesFile,
    maxLines,
    retentionHours,
  });

  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  const post = checks.find((check) => check?.id === "post_summary") || null;
  const reel = checks.find((check) => check?.id === "reel_summary") || null;

  console.log(
    `[feed-slo-sample] ok=${Boolean(payload?.ok)} strict=${strict} fail_on_breach=${failOnBreach} post_p95=${post?.p95_ms ?? "na"} reel_p95=${reel?.p95_ms ?? "na"} file=${samplesFile}`
  );

  if (failOnBreach && !payload?.ok) {
    process.exitCode = 1;
  }
};

try {
  main();
} catch (error) {
  console.error(`[feed-slo-sample] ${String(error?.message || error)}`);
  process.exit(1);
}
