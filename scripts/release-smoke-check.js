#!/usr/bin/env node

/* eslint-disable no-console */
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const loadSmokeEnv = () => {
  dotenv.config();

  const explicitEnvFile = String(process.env.SMOKE_ENV_FILE || process.env.ENV_FILE || "").trim();
  const fallbackGreenEnvFile =
    !explicitEnvFile && String(process.env.SMOKE_BASE_URL || "").includes(":3001")
      ? ".env.green"
      : "";
  const selectedEnvFile = explicitEnvFile || fallbackGreenEnvFile;

  if (selectedEnvFile) {
    dotenv.config({
      path: path.resolve(process.cwd(), selectedEnvFile),
      override: true,
    });
  }

  applyFileBackedSecrets(process.env, {
    forceOverride: false,
    allowCreateMissingTargets: isTruthy(process.env.SECRETS_FILE_CREATE_MISSING_TARGETS),
    baseDir: process.cwd(),
  });
};

loadSmokeEnv();

const BASE_URL = String(process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const AUTH_TOKEN = String(process.env.SMOKE_AUTH_TOKEN || "").trim();
const INTERNAL_DEBUG_TOKEN = String(process.env.INTERNAL_DEBUG_TOKEN || "").trim();

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const toByteLength = (value) => {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value));
};

const baseHeaders = () => {
  const headers = {};
  if (AUTH_TOKEN) headers.authorization = `Bearer ${AUTH_TOKEN}`;
  return headers;
};

const debugHeaders = () => {
  const headers = { "x-internal-debug": "true" };
  if (INTERNAL_DEBUG_TOKEN) {
    headers["x-internal-debug-token"] = INTERNAL_DEBUG_TOKEN;
  }
  return headers;
};

const probe = async ({ name, path, headers = {}, timeout = 15000, expected = [200] }) => {
  const started = nowMs();
  try {
    const response = await axios.get(`${BASE_URL}${path}`, {
      headers,
      timeout,
      responseType: "arraybuffer",
      validateStatus: () => true,
    });
    const duration = round2(nowMs() - started);
    const size = Number(response.headers["content-length"] || 0) || toByteLength(response.data);
    const ok = expected.includes(response.status);
    return { name, ok, status: response.status, duration_ms: duration, bytes: size };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 0,
      duration_ms: round2(nowMs() - started),
      bytes: 0,
      error: String(error && error.message ? error.message : error),
    };
  }
};

const main = async () => {
  const checks = [];

  checks.push(
    await probe({
      name: "ping",
      path: "/api/v1/ping",
    })
  );

  checks.push(
    await probe({
      name: "live",
      path: "/api/v1/live",
    })
  );

  checks.push(
    await probe({
      name: "ready",
      path: "/api/v1/ready",
      expected: [200],
    })
  );

  checks.push(
    await probe({
      name: "bootstrap_home",
      path: "/api/v1/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5",
      headers: baseHeaders(),
      expected: AUTH_TOKEN ? [200] : [200, 401],
    })
  );

  checks.push(
    await probe({
      name: "internal_summary_routes",
      path: "/api/v1/internal/debug/summary-routes",
      headers: debugHeaders(),
      expected: [200],
    })
  );

  checks.push(
    await probe({
      name: "internal_perf_check",
      path: "/api/v1/internal/perf-check",
      headers: { ...baseHeaders(), ...debugHeaders() },
      expected: AUTH_TOKEN ? [200] : [200, 401],
      timeout: 30000,
    })
  );

  const failed = checks.filter((check) => !check.ok);
  const summary = {
    base_url: BASE_URL,
    checks,
    pass: failed.length === 0,
    failed_count: failed.length,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
