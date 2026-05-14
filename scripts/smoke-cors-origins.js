#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");

const parseArgs = () => {
  const out = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i += 1) {
    const current = String(argv[i] || "");
    if (!current.startsWith("--")) continue;

    const eq = current.indexOf("=");
    if (eq > 2) {
      out[current.slice(2, eq).trim()] = current.slice(eq + 1).trim();
      continue;
    }

    const key = current.slice(2).trim();
    const next = String(argv[i + 1] || "");
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }

  return out;
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
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

const splitCsv = (raw) =>
  String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

const normalizeBaseUrl = (rawValue) => {
  const trimmed = String(rawValue || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "https://api.minhoo.xyz/api/v1";
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
};

const normalizeEndpoint = (raw) => {
  const cleaned = String(raw || "/auth/login").trim();
  if (!cleaned) return "/auth/login";
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
};

const parseHeaderCsv = (value) =>
  splitCsv(value).map((item) => item.toLowerCase());

const parseAllowListHeader = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const hasTokenOrWildcard = (values, token) => {
  const normalizedToken = String(token || "").trim().toLowerCase();
  return values.includes("*") || values.includes(normalizedToken);
};

const buildCheck = ({
  origin,
  url,
  requestMethod,
  requestHeaders,
  expectedStatuses,
  timeoutMs,
}) =>
  axios
    .request({
      method: "OPTIONS",
      url,
      timeout: timeoutMs,
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": requestMethod,
        "Access-Control-Request-Headers": requestHeaders.join(","),
      },
      validateStatus: () => true,
    })
    .then((response) => {
      const status = Number(response.status || 0);
      const allowOrigin = String(response.headers?.["access-control-allow-origin"] || "").trim();
      const allowMethods = parseAllowListHeader(response.headers?.["access-control-allow-methods"]);
      const allowHeaders = parseAllowListHeader(response.headers?.["access-control-allow-headers"]);
      const vary = String(response.headers?.vary || "").trim();

      const errors = [];
      if (!expectedStatuses.includes(status)) {
        errors.push(`unexpected status ${status}`);
      }

      if (!(allowOrigin === origin || allowOrigin === "*")) {
        errors.push(`allow-origin mismatch (${allowOrigin || "<empty>"})`);
      }

      if (!hasTokenOrWildcard(allowMethods, requestMethod.toLowerCase())) {
        errors.push(
          `allow-methods missing ${requestMethod.toUpperCase()} (${allowMethods.join(",") || "<empty>"})`
        );
      }

      for (const header of requestHeaders) {
        if (!hasTokenOrWildcard(allowHeaders, header)) {
          errors.push(`allow-headers missing ${header} (${allowHeaders.join(",") || "<empty>"})`);
        }
      }

      return {
        origin,
        ok: errors.length === 0,
        status,
        allow_origin: allowOrigin || null,
        allow_methods: allowMethods,
        allow_headers: allowHeaders,
        vary: vary || null,
        errors,
      };
    })
    .catch((error) => ({
      origin,
      ok: false,
      status: 0,
      allow_origin: null,
      allow_methods: [],
      allow_headers: [],
      vary: null,
      errors: [String(error?.message || error)],
    }));

const main = async () => {
  loadEnv();
  const argv = parseArgs();

  const strict = isTruthy(argv.strict ?? process.env.CORS_MONITOR_STRICT ?? "0");
  const json = isTruthy(argv.json ?? process.env.CORS_MONITOR_JSON ?? "0");
  const baseUrl = normalizeBaseUrl(
    argv["base-url"] || process.env.CORS_MONITOR_BASE_URL || process.env.SMOKE_BASE_URL
  );
  const endpoint = normalizeEndpoint(argv.endpoint || process.env.CORS_MONITOR_ENDPOINT || "/auth/login");
  const timeoutMs = toPositiveInt(argv["timeout-ms"] || process.env.CORS_MONITOR_TIMEOUT_MS, 15000);
  const requestMethod = String(
    argv["request-method"] || process.env.CORS_MONITOR_REQUEST_METHOD || "POST"
  )
    .trim()
    .toUpperCase();
  const requestHeaders = parseHeaderCsv(
    argv["request-headers"] ||
      process.env.CORS_MONITOR_REQUEST_HEADERS ||
      "content-type,authorization"
  );
  const expectedStatuses = splitCsv(
    argv["expected-statuses"] || process.env.CORS_MONITOR_EXPECTED_STATUSES || "204,200"
  )
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const origins = splitCsv(
    argv.origins || process.env.CORS_MONITOR_ORIGINS || process.env.CORS_ORIGINS
  );

  const summary = {
    pass: true,
    strict,
    base_url: baseUrl,
    endpoint,
    request_method: requestMethod,
    request_headers: requestHeaders,
    expected_statuses: expectedStatuses,
    checked_origins: origins.length,
    checks: [],
    errors: [],
  };

  if (!origins.length) {
    summary.pass = !strict;
    summary.errors.push("no origins to validate (set CORS_MONITOR_ORIGINS or CORS_ORIGINS)");
  } else if (!requestHeaders.length) {
    summary.pass = false;
    summary.errors.push("no request headers configured for preflight check");
  } else if (!expectedStatuses.length) {
    summary.pass = false;
    summary.errors.push("expected statuses list is empty");
  } else {
    const url = `${baseUrl}${endpoint}`;
    const checks = await Promise.all(
      origins.map((origin) =>
        buildCheck({
          origin,
          url,
          requestMethod,
          requestHeaders,
          expectedStatuses,
          timeoutMs,
        })
      )
    );
    summary.checks = checks;
    const failed = checks.filter((item) => !item.ok);
    if (failed.length > 0) {
      summary.pass = false;
      summary.errors.push(`${failed.length}/${checks.length} origin checks failed`);
    }
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[cors-smoke] base=${summary.base_url} endpoint=${summary.endpoint} strict=${
        summary.strict ? "on" : "off"
      }`
    );
    if (summary.checks.length) {
      for (const item of summary.checks) {
        const reason = item.errors.length ? ` errors=${item.errors.join(" | ")}` : "";
        console.log(
          `- ${item.origin} status=${item.status} acao=${item.allow_origin || "-"} ok=${
            item.ok ? "yes" : "no"
          }${reason}`
        );
      }
    }
    if (summary.errors.length) {
      for (const error of summary.errors) {
        console.log(`[cors-smoke][WARN] ${error}`);
      }
    }
    console.log(`[cors-smoke] pass=${summary.pass ? "yes" : "no"}`);
  }

  if (!summary.pass) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
