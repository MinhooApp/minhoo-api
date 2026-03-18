#!/usr/bin/env node

/* eslint-disable no-console */
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

const hasValue = (value) => String(value ?? "").trim().length > 0;

const checks = [];
const addCheck = (name, ok, details, severity = "error") => {
  checks.push({ name, ok, severity, details });
};

const NODE_ENV = String(process.env.NODE_ENV ?? "").trim().toLowerCase();
const DB_SYNC_ON_BOOT = process.env.DB_SYNC_ON_BOOT;
const CORS_ORIGINS = String(process.env.CORS_ORIGINS ?? "").trim();
const CORS_ALLOW_ALL_IN_PROD = isTruthy(process.env.CORS_ALLOW_ALL_IN_PROD);
const INTERNAL_DEBUG_TOKEN = String(process.env.INTERNAL_DEBUG_TOKEN ?? "").trim();
const TRUST_PROXY = isTruthy(process.env.TRUST_PROXY);

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
  "TRUST_PROXY set when behind reverse proxy",
  TRUST_PROXY,
  `TRUST_PROXY=${String(process.env.TRUST_PROXY ?? "<empty>")}`,
  TRUST_PROXY ? "info" : "warn"
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
