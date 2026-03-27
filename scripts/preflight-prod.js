#!/usr/bin/env node

/* eslint-disable no-console */
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

const loadPreflightEnv = () => {
  dotenv.config();

  const explicitEnvFile = String(process.env.PREFLIGHT_ENV_FILE || process.env.ENV_FILE || "").trim();
  if (explicitEnvFile) {
    dotenv.config({
      path: path.resolve(process.cwd(), explicitEnvFile),
      override: true,
    });
  }

  applyFileBackedSecrets(process.env, {
    forceOverride: false,
    allowCreateMissingTargets: isTruthy(process.env.SECRETS_FILE_CREATE_MISSING_TARGETS),
    baseDir: process.cwd(),
  });
};

loadPreflightEnv();

const hasValue = (value) => String(value ?? "").trim().length > 0;

const checks = [];
const addCheck = (name, ok, details, severity = "error") => {
  checks.push({ name, ok, severity, details });
};

const NODE_ENV = String(process.env.NODE_ENV ?? "").trim().toLowerCase();
const DB_SYNC_ON_BOOT = process.env.DB_SYNC_ON_BOOT;
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 0);
const CORS_ORIGINS = String(process.env.CORS_ORIGINS ?? "").trim();
const CORS_ALLOW_ALL_IN_PROD = isTruthy(process.env.CORS_ALLOW_ALL_IN_PROD);
const INTERNAL_DEBUG_TOKEN = String(process.env.INTERNAL_DEBUG_TOKEN ?? "").trim();
const INTERNAL_DEBUG_ALLOW_REMOTE = isTruthy(process.env.INTERNAL_DEBUG_ALLOW_REMOTE);
const INTERNAL_DEBUG_IP_ALLOWLIST = String(process.env.INTERNAL_DEBUG_IP_ALLOWLIST ?? "").trim();
const TRUST_PROXY = isTruthy(process.env.TRUST_PROXY);
const AUTH_RATE_MAX_LOGIN = Number(process.env.AUTH_RATE_MAX_LOGIN ?? 0);
const HTTP_JSON_LIMIT = String(process.env.HTTP_JSON_LIMIT ?? "").trim();
const HTTP_URLENCODED_LIMIT = String(process.env.HTTP_URLENCODED_LIMIT ?? "").trim();
const HTTP_MAX_URL_LENGTH = Number(process.env.HTTP_MAX_URL_LENGTH ?? 0);
const HTTP_MAX_HEADERS_COUNT = Number(process.env.HTTP_MAX_HEADERS_COUNT ?? 0);
const HTTP_MAX_REQUESTS_PER_SOCKET = Number(process.env.HTTP_MAX_REQUESTS_PER_SOCKET ?? 0);
const HTTP_SOCKET_TIMEOUT_MS = Number(process.env.HTTP_SOCKET_TIMEOUT_MS ?? 0);
const HTTP_MAX_CONNECTIONS = Number(process.env.HTTP_MAX_CONNECTIONS ?? 0);
const READY_CHECK_CACHE_MS = Number(process.env.READY_CHECK_CACHE_MS ?? 0);
const READY_DB_TIMEOUT_MS = Number(process.env.READY_DB_TIMEOUT_MS ?? 0);
const APP_RATE_WINDOW_MS = Number(process.env.APP_RATE_WINDOW_MS ?? 0);
const APP_RATE_MAX_ENTRIES = Number(process.env.APP_RATE_MAX_ENTRIES ?? 0);
const CHAT_RATE_MAX_READ = Number(process.env.CHAT_RATE_MAX_READ ?? 0);
const CHAT_RATE_MAX_WRITE = Number(process.env.CHAT_RATE_MAX_WRITE ?? 0);
const CHAT_RATE_MAX_REPORT = Number(process.env.CHAT_RATE_MAX_REPORT ?? 0);
const POST_RATE_MAX_READ = Number(process.env.POST_RATE_MAX_READ ?? 0);
const POST_RATE_MAX_WRITE = Number(process.env.POST_RATE_MAX_WRITE ?? 0);
const REEL_RATE_MAX_READ = Number(process.env.REEL_RATE_MAX_READ ?? 0);
const REEL_RATE_MAX_WRITE = Number(process.env.REEL_RATE_MAX_WRITE ?? 0);
const INTERNAL_RATE_MAX = Number(process.env.INTERNAL_RATE_MAX ?? 0);
const SOCKET_MAX_HTTP_BUFFER_SIZE = Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE ?? 0);
const SOCKET_CONNECT_TIMEOUT_MS = Number(process.env.SOCKET_CONNECT_TIMEOUT_MS ?? 0);

addCheck(
  "NODE_ENV is production",
  NODE_ENV === "production",
  `NODE_ENV=${NODE_ENV || "<empty>"}`
);

addCheck(
  "DB_SYNC_ON_BOOT disabled in production",
  !isTruthy(DB_SYNC_ON_BOOT),
  `DB_SYNC_ON_BOOT=${String(DB_SYNC_ON_BOOT ?? "<empty>")}`
);

addCheck(
  "SHUTDOWN_GRACE_MS configured",
  Number.isFinite(SHUTDOWN_GRACE_MS) && SHUTDOWN_GRACE_MS >= 5000,
  `SHUTDOWN_GRACE_MS=${String(process.env.SHUTDOWN_GRACE_MS ?? "<empty>")} (recommended: 15000)`,
  Number.isFinite(SHUTDOWN_GRACE_MS) && SHUTDOWN_GRACE_MS >= 5000 ? "info" : "warn"
);

if (CORS_ALLOW_ALL_IN_PROD) {
  addCheck(
    "CORS allow all in production",
    false,
    "CORS_ALLOW_ALL_IN_PROD=true (security risk)",
    "warn"
  );
} else {
  addCheck(
    "CORS_ORIGINS configured",
    hasValue(CORS_ORIGINS),
    `CORS_ORIGINS=${CORS_ORIGINS || "<empty>"}`
  );
}

addCheck(
  "INTERNAL_DEBUG_TOKEN configured",
  hasValue(INTERNAL_DEBUG_TOKEN),
  hasValue(INTERNAL_DEBUG_TOKEN)
    ? "INTERNAL_DEBUG_TOKEN is set"
    : "INTERNAL_DEBUG_TOKEN missing (internal debug endpoints blocked in prod)",
  hasValue(INTERNAL_DEBUG_TOKEN) ? "info" : "warn"
);

addCheck(
  "INTERNAL_DEBUG_ALLOW_REMOTE disabled",
  !INTERNAL_DEBUG_ALLOW_REMOTE,
  `INTERNAL_DEBUG_ALLOW_REMOTE=${String(process.env.INTERNAL_DEBUG_ALLOW_REMOTE ?? "<empty>")}`,
  INTERNAL_DEBUG_ALLOW_REMOTE ? "warn" : "info"
);

addCheck(
  "INTERNAL_DEBUG_IP_ALLOWLIST configured",
  hasValue(INTERNAL_DEBUG_IP_ALLOWLIST),
  `INTERNAL_DEBUG_IP_ALLOWLIST=${INTERNAL_DEBUG_IP_ALLOWLIST || "<empty>"}`,
  hasValue(INTERNAL_DEBUG_IP_ALLOWLIST) ? "info" : "warn"
);

addCheck(
  "TRUST_PROXY set when behind reverse proxy",
  TRUST_PROXY,
  `TRUST_PROXY=${String(process.env.TRUST_PROXY ?? "<empty>")}`,
  TRUST_PROXY ? "info" : "warn"
);

addCheck(
  "AUTH_RATE_MAX_LOGIN configured",
  Number.isFinite(AUTH_RATE_MAX_LOGIN) && AUTH_RATE_MAX_LOGIN > 0,
  `AUTH_RATE_MAX_LOGIN=${String(process.env.AUTH_RATE_MAX_LOGIN ?? "<empty>")}`,
  "warn"
);

addCheck(
  "HTTP_JSON_LIMIT configured",
  hasValue(HTTP_JSON_LIMIT),
  `HTTP_JSON_LIMIT=${HTTP_JSON_LIMIT || "<empty>"} (recommended: 1mb)`,
  hasValue(HTTP_JSON_LIMIT) ? "info" : "warn"
);

addCheck(
  "HTTP_URLENCODED_LIMIT configured",
  hasValue(HTTP_URLENCODED_LIMIT),
  `HTTP_URLENCODED_LIMIT=${HTTP_URLENCODED_LIMIT || "<empty>"} (recommended: 1mb)`,
  hasValue(HTTP_URLENCODED_LIMIT) ? "info" : "warn"
);

addCheck(
  "HTTP_MAX_URL_LENGTH configured",
  Number.isFinite(HTTP_MAX_URL_LENGTH) && HTTP_MAX_URL_LENGTH >= 1024,
  `HTTP_MAX_URL_LENGTH=${String(process.env.HTTP_MAX_URL_LENGTH ?? "<empty>")} (recommended: 8192)`,
  Number.isFinite(HTTP_MAX_URL_LENGTH) && HTTP_MAX_URL_LENGTH >= 1024 ? "info" : "warn"
);

addCheck(
  "HTTP_MAX_HEADERS_COUNT configured",
  Number.isFinite(HTTP_MAX_HEADERS_COUNT) && HTTP_MAX_HEADERS_COUNT >= 32,
  `HTTP_MAX_HEADERS_COUNT=${String(process.env.HTTP_MAX_HEADERS_COUNT ?? "<empty>")} (recommended: 120)`,
  Number.isFinite(HTTP_MAX_HEADERS_COUNT) && HTTP_MAX_HEADERS_COUNT >= 32 ? "info" : "warn"
);

addCheck(
  "HTTP_MAX_REQUESTS_PER_SOCKET configured",
  Number.isFinite(HTTP_MAX_REQUESTS_PER_SOCKET) && HTTP_MAX_REQUESTS_PER_SOCKET >= 100,
  `HTTP_MAX_REQUESTS_PER_SOCKET=${String(process.env.HTTP_MAX_REQUESTS_PER_SOCKET ?? "<empty>")} (recommended: 1000)`,
  Number.isFinite(HTTP_MAX_REQUESTS_PER_SOCKET) && HTTP_MAX_REQUESTS_PER_SOCKET >= 100
    ? "info"
    : "warn"
);

addCheck(
  "HTTP_SOCKET_TIMEOUT_MS configured",
  Number.isFinite(HTTP_SOCKET_TIMEOUT_MS) && HTTP_SOCKET_TIMEOUT_MS >= 5000,
  `HTTP_SOCKET_TIMEOUT_MS=${String(process.env.HTTP_SOCKET_TIMEOUT_MS ?? "<empty>")} (recommended: 60000)`,
  Number.isFinite(HTTP_SOCKET_TIMEOUT_MS) && HTTP_SOCKET_TIMEOUT_MS >= 5000
    ? "info"
    : "warn"
);

addCheck(
  "HTTP_MAX_CONNECTIONS set (optional)",
  Number.isFinite(HTTP_MAX_CONNECTIONS) && HTTP_MAX_CONNECTIONS >= 0,
  `HTTP_MAX_CONNECTIONS=${String(process.env.HTTP_MAX_CONNECTIONS ?? "<empty>")} (0 = unlimited)`,
  "info"
);

addCheck(
  "READY_CHECK_CACHE_MS configured",
  Number.isFinite(READY_CHECK_CACHE_MS) && READY_CHECK_CACHE_MS >= 500,
  `READY_CHECK_CACHE_MS=${String(process.env.READY_CHECK_CACHE_MS ?? "<empty>")} (recommended: 5000)`,
  Number.isFinite(READY_CHECK_CACHE_MS) && READY_CHECK_CACHE_MS >= 500 ? "info" : "warn"
);

addCheck(
  "READY_DB_TIMEOUT_MS configured",
  Number.isFinite(READY_DB_TIMEOUT_MS) && READY_DB_TIMEOUT_MS >= 500,
  `READY_DB_TIMEOUT_MS=${String(process.env.READY_DB_TIMEOUT_MS ?? "<empty>")} (recommended: 2000)`,
  Number.isFinite(READY_DB_TIMEOUT_MS) && READY_DB_TIMEOUT_MS >= 500 ? "info" : "warn"
);

addCheck(
  "APP_RATE_WINDOW_MS configured",
  Number.isFinite(APP_RATE_WINDOW_MS) && APP_RATE_WINDOW_MS >= 5000,
  `APP_RATE_WINDOW_MS=${String(process.env.APP_RATE_WINDOW_MS ?? "<empty>")} (recommended: 60000)`,
  Number.isFinite(APP_RATE_WINDOW_MS) && APP_RATE_WINDOW_MS >= 5000 ? "info" : "warn"
);

addCheck(
  "APP_RATE_MAX_ENTRIES configured",
  Number.isFinite(APP_RATE_MAX_ENTRIES) && APP_RATE_MAX_ENTRIES >= 5000,
  `APP_RATE_MAX_ENTRIES=${String(process.env.APP_RATE_MAX_ENTRIES ?? "<empty>")} (recommended: 50000)`,
  Number.isFinite(APP_RATE_MAX_ENTRIES) && APP_RATE_MAX_ENTRIES >= 5000 ? "info" : "warn"
);

addCheck(
  "CHAT_RATE_MAX_READ configured",
  Number.isFinite(CHAT_RATE_MAX_READ) && CHAT_RATE_MAX_READ >= 30,
  `CHAT_RATE_MAX_READ=${String(process.env.CHAT_RATE_MAX_READ ?? "<empty>")} (recommended: 120)`,
  Number.isFinite(CHAT_RATE_MAX_READ) && CHAT_RATE_MAX_READ >= 30 ? "info" : "warn"
);

addCheck(
  "CHAT_RATE_MAX_WRITE configured",
  Number.isFinite(CHAT_RATE_MAX_WRITE) && CHAT_RATE_MAX_WRITE >= 10,
  `CHAT_RATE_MAX_WRITE=${String(process.env.CHAT_RATE_MAX_WRITE ?? "<empty>")} (recommended: 30)`,
  Number.isFinite(CHAT_RATE_MAX_WRITE) && CHAT_RATE_MAX_WRITE >= 10 ? "info" : "warn"
);

addCheck(
  "CHAT_RATE_MAX_REPORT configured",
  Number.isFinite(CHAT_RATE_MAX_REPORT) && CHAT_RATE_MAX_REPORT >= 5,
  `CHAT_RATE_MAX_REPORT=${String(process.env.CHAT_RATE_MAX_REPORT ?? "<empty>")} (recommended: 10)`,
  Number.isFinite(CHAT_RATE_MAX_REPORT) && CHAT_RATE_MAX_REPORT >= 5 ? "info" : "warn"
);

addCheck(
  "POST_RATE_MAX_READ configured",
  Number.isFinite(POST_RATE_MAX_READ) && POST_RATE_MAX_READ >= 50,
  `POST_RATE_MAX_READ=${String(process.env.POST_RATE_MAX_READ ?? "<empty>")} (recommended: 150)`,
  Number.isFinite(POST_RATE_MAX_READ) && POST_RATE_MAX_READ >= 50 ? "info" : "warn"
);

addCheck(
  "POST_RATE_MAX_WRITE configured",
  Number.isFinite(POST_RATE_MAX_WRITE) && POST_RATE_MAX_WRITE >= 10,
  `POST_RATE_MAX_WRITE=${String(process.env.POST_RATE_MAX_WRITE ?? "<empty>")} (recommended: 25)`,
  Number.isFinite(POST_RATE_MAX_WRITE) && POST_RATE_MAX_WRITE >= 10 ? "info" : "warn"
);

addCheck(
  "REEL_RATE_MAX_READ configured",
  Number.isFinite(REEL_RATE_MAX_READ) && REEL_RATE_MAX_READ >= 50,
  `REEL_RATE_MAX_READ=${String(process.env.REEL_RATE_MAX_READ ?? "<empty>")} (recommended: 150)`,
  Number.isFinite(REEL_RATE_MAX_READ) && REEL_RATE_MAX_READ >= 50 ? "info" : "warn"
);

addCheck(
  "REEL_RATE_MAX_WRITE configured",
  Number.isFinite(REEL_RATE_MAX_WRITE) && REEL_RATE_MAX_WRITE >= 10,
  `REEL_RATE_MAX_WRITE=${String(process.env.REEL_RATE_MAX_WRITE ?? "<empty>")} (recommended: 30)`,
  Number.isFinite(REEL_RATE_MAX_WRITE) && REEL_RATE_MAX_WRITE >= 10 ? "info" : "warn"
);

addCheck(
  "INTERNAL_RATE_MAX configured",
  Number.isFinite(INTERNAL_RATE_MAX) && INTERNAL_RATE_MAX >= 5,
  `INTERNAL_RATE_MAX=${String(process.env.INTERNAL_RATE_MAX ?? "<empty>")} (recommended: 20)`,
  Number.isFinite(INTERNAL_RATE_MAX) && INTERNAL_RATE_MAX >= 5 ? "info" : "warn"
);

addCheck(
  "SOCKET_MAX_HTTP_BUFFER_SIZE configured",
  Number.isFinite(SOCKET_MAX_HTTP_BUFFER_SIZE) && SOCKET_MAX_HTTP_BUFFER_SIZE >= 32768,
  `SOCKET_MAX_HTTP_BUFFER_SIZE=${String(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE ?? "<empty>")} (recommended: 1000000)`,
  Number.isFinite(SOCKET_MAX_HTTP_BUFFER_SIZE) && SOCKET_MAX_HTTP_BUFFER_SIZE >= 32768
    ? "info"
    : "warn"
);

addCheck(
  "SOCKET_CONNECT_TIMEOUT_MS configured",
  Number.isFinite(SOCKET_CONNECT_TIMEOUT_MS) && SOCKET_CONNECT_TIMEOUT_MS >= 5000,
  `SOCKET_CONNECT_TIMEOUT_MS=${String(process.env.SOCKET_CONNECT_TIMEOUT_MS ?? "<empty>")} (recommended: 45000)`,
  Number.isFinite(SOCKET_CONNECT_TIMEOUT_MS) && SOCKET_CONNECT_TIMEOUT_MS >= 5000
    ? "info"
    : "warn"
);

const errors = checks.filter((item) => !item.ok && item.severity === "error");
const warns = checks.filter((item) => !item.ok && item.severity === "warn");

console.log(
  JSON.stringify(
    {
      pass: errors.length === 0,
      error_count: errors.length,
      warn_count: warns.length,
      checks,
    },
    null,
    2
  )
);

if (errors.length > 0) {
  process.exitCode = 1;
}
