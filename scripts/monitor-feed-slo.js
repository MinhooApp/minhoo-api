#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");

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

const toPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const toNonNegativeNumber = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const nowIso = () => new Date().toISOString();
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const round2 = (value) => Math.round(Number(value) * 100) / 100;

const parseArgs = () => {
  const parsed = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || "");
    if (!current.startsWith("--")) continue;
    const eq = current.indexOf("=");
    if (eq > 2) {
      parsed[current.slice(2, eq).trim()] = current.slice(eq + 1).trim();
      continue;
    }
    const key = current.slice(2).trim();
    const next = String(argv[index + 1] || "");
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "1";
    }
  }
  return parsed;
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

const normalizeBaseUrl = (rawValue) => {
  const trimmed = String(rawValue || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "http://127.0.0.1:3000/api/v1";
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
};

const extractObservability = (payload) => {
  const byBody = payload?.body?.observability;
  if (byBody && typeof byBody === "object") return byBody;
  const direct = payload?.observability;
  if (direct && typeof direct === "object") return direct;
  return null;
};

const metricKey = (method, route, summary) =>
  `${String(method || "GET").toUpperCase()}:${String(route || "")}:${summary ? "summary" : "full"}`;

const buildHotspotMap = (hotspots) => {
  const map = new Map();
  for (const row of Array.isArray(hotspots) ? hotspots : []) {
    const key = metricKey(row?.method, row?.route, Boolean(row?.summary));
    if (!key) continue;
    map.set(key, {
      method: String(row?.method || "GET").toUpperCase(),
      route: String(row?.route || ""),
      summary: Boolean(row?.summary),
      count: Number(row?.count || 0),
      p95_ms: Number(row?.p95_ms || 0),
      p99_ms: Number(row?.p99_ms || 0),
      avg_ms: Number(row?.avg_ms || 0),
      error_rate_percent: Number(row?.error_rate_percent || 0),
      throttled_429_rate_percent: Number(row?.throttled_429_rate_percent || 0),
    });
  }
  return map;
};

const evaluate = ({
  totals,
  hotspotMap,
  bootstrapCache,
  bootstrapNotificationsCache,
  thresholds,
}) => {
  const failures = [];
  const warnings = [];
  const checks = [];

  const requests = Number(totals?.requests || 0);
  const p95 = Number(totals?.p95_ms || 0);
  const p99 = Number(totals?.p99_ms || 0);
  const errorRate = Number(totals?.error_rate_percent || 0);
  const throttled429 = Number(totals?.throttled_429_rate_percent || 0);

  if (requests < thresholds.minWindowRequests) {
    warnings.push(
      `Pocas muestras globales: requests=${requests} < min_window_requests=${thresholds.minWindowRequests}`
    );
  }

  if (errorRate > thresholds.max5xxPct) {
    failures.push(
      `5xx global alto: error_rate_percent=${errorRate}% > max_5xx_percent=${thresholds.max5xxPct}%`
    );
  }

  if (throttled429 > thresholds.max429Pct) {
    const message = `429 global alto: throttled_429_rate_percent=${throttled429}% > max_429_percent=${thresholds.max429Pct}%`;
    if (thresholds.strict429) failures.push(message);
    else warnings.push(message);
  }

  const routeTargets = [
    {
      id: "post_summary",
      key: metricKey("GET", "/api/v1/post", true),
      label: "GET /api/v1/post summary",
      p95BudgetMs: thresholds.postSummaryP95Ms,
    },
    {
      id: "reel_summary",
      key: metricKey("GET", "/api/v1/reel", true),
      label: "GET /api/v1/reel summary",
      p95BudgetMs: thresholds.reelSummaryP95Ms,
    },
    {
      id: "bootstrap_home_full",
      key: metricKey("GET", "/api/v1/bootstrap/home", false),
      label: "GET /api/v1/bootstrap/home full",
      p95BudgetMs: thresholds.bootstrapFullP95Ms,
    },
  ];

  for (const target of routeTargets) {
    const metric = hotspotMap.get(target.key) || null;
    const count = Number(metric?.count || 0);
    const p95Ms = Number(metric?.p95_ms || 0);
    const routeErrorRate = Number(metric?.error_rate_percent || 0);

    const check = {
      id: target.id,
      label: target.label,
      route_key: target.key,
      p95_budget_ms: target.p95BudgetMs,
      min_route_samples: thresholds.minRouteSamples,
      count,
      p95_ms: metric ? p95Ms : null,
      error_rate_percent: metric ? routeErrorRate : null,
      status: "ok",
      reason: "",
    };

    if (!metric || count < thresholds.minRouteSamples) {
      check.status = "warning";
      check.reason = `muestras insuficientes (${count}/${thresholds.minRouteSamples})`;
      warnings.push(`${target.label}: ${check.reason}`);
      checks.push(check);
      continue;
    }

    if (p95Ms > target.p95BudgetMs) {
      check.status = "fail";
      check.reason = `p95_ms=${p95Ms} > budget_ms=${target.p95BudgetMs}`;
      failures.push(`${target.label}: ${check.reason}`);
    } else if (routeErrorRate > thresholds.max5xxPct) {
      check.status = "fail";
      check.reason = `error_rate_percent=${routeErrorRate}% > max_5xx_percent=${thresholds.max5xxPct}%`;
      failures.push(`${target.label}: ${check.reason}`);
    } else {
      check.reason = `ok (p95_ms=${p95Ms}, count=${count})`;
    }
    checks.push(check);
  }

  const bootstrapSamples = Number(bootstrapCache?.hit || 0) +
    Number(bootstrapCache?.miss || 0) +
    Number(bootstrapCache?.coalesced || 0) +
    Number(bootstrapCache?.bypass || 0) +
    Number(bootstrapCache?.other || 0);
  const bootstrapHitRate = Number(bootstrapCache?.hit_rate_percent || 0);
  if (
    bootstrapSamples >= thresholds.cacheMinSamples &&
    bootstrapHitRate < thresholds.bootstrapHitMinPct
  ) {
    warnings.push(
      `Cache hit bootstrap bajo: hit_rate=${bootstrapHitRate}% < min_hit=${thresholds.bootstrapHitMinPct}% (samples=${bootstrapSamples})`
    );
  }

  const notifSamples = Number(bootstrapNotificationsCache?.hit || 0) +
    Number(bootstrapNotificationsCache?.miss || 0) +
    Number(bootstrapNotificationsCache?.coalesced || 0) +
    Number(bootstrapNotificationsCache?.bypass || 0) +
    Number(bootstrapNotificationsCache?.other || 0);
  const notifHitRate = Number(bootstrapNotificationsCache?.hit_rate_percent || 0);
  if (
    notifSamples >= thresholds.cacheMinSamples &&
    notifHitRate < thresholds.bootstrapNotifHitMinPct
  ) {
    warnings.push(
      `Cache hit notifications bajo: hit_rate=${notifHitRate}% < min_hit=${thresholds.bootstrapNotifHitMinPct}% (samples=${notifSamples})`
    );
  }

  return {
    checks,
    failures,
    warnings,
    global: {
      requests,
      p95_ms: p95,
      p99_ms: p99,
      error_rate_percent: errorRate,
      throttled_429_rate_percent: throttled429,
      bootstrap_hit_rate_percent: bootstrapHitRate,
      bootstrap_notifications_hit_rate_percent: notifHitRate,
      bootstrap_samples_total: bootstrapSamples,
      bootstrap_notifications_samples_total: notifSamples,
    },
  };
};

const printHuman = ({ at, endpoint, thresholds, result }) => {
  console.log(`[feed-slo] at=${at}`);
  console.log(`[feed-slo] endpoint=${endpoint}`);
  console.log(
    `[feed-slo] global req=${result.global.requests} p95=${result.global.p95_ms}ms p99=${result.global.p99_ms}ms 5xx=${result.global.error_rate_percent}% 429=${result.global.throttled_429_rate_percent}%`
  );
  for (const check of result.checks) {
    console.log(
      `[feed-slo] ${check.status.toUpperCase()} ${check.label}: ${check.reason}`
    );
  }
  console.log(
    `[feed-slo] thresholds p95(post=${thresholds.postSummaryP95Ms}ms,reel=${thresholds.reelSummaryP95Ms}ms,bootstrap=${thresholds.bootstrapFullP95Ms}ms) max5xx=${thresholds.max5xxPct}% max429=${thresholds.max429Pct}%`
  );
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.log(`[feed-slo][FAIL] ${failure}`);
    }
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`[feed-slo][WARN] ${warning}`);
    }
  }
  if (result.failures.length === 0 && result.warnings.length === 0) {
    console.log("[feed-slo] healthy");
  }
};

const main = async () => {
  loadEnv();
  const argv = parseArgs();

  const endpoint = normalizeBaseUrl(
    argv["base-url"] || process.env.FEED_SLO_BASE_URL || process.env.SMOKE_BASE_URL
  );
  const windowSize = toPositiveInt(argv.window || process.env.FEED_SLO_WINDOW || 300, 300);
  const timeoutMs = toPositiveInt(
    argv["timeout-ms"] || process.env.FEED_SLO_TIMEOUT_MS || 15000,
    15000
  );
  const strict = isTruthy(argv.strict || process.env.FEED_SLO_STRICT || "1");
  const asJson = isTruthy(argv.json || process.env.FEED_SLO_JSON || "0");

  const thresholds = {
    minWindowRequests: toPositiveInt(
      argv["min-window-requests"] || process.env.FEED_SLO_MIN_WINDOW_REQUESTS || 40,
      40
    ),
    minRouteSamples: toPositiveInt(
      argv["min-route-samples"] || process.env.FEED_SLO_MIN_ROUTE_SAMPLES || 20,
      20
    ),
    postSummaryP95Ms: toPositiveNumber(
      argv["post-p95-ms"] || process.env.FEED_SLO_POST_SUMMARY_P95_MS || 250,
      250
    ),
    reelSummaryP95Ms: toPositiveNumber(
      argv["reel-p95-ms"] || process.env.FEED_SLO_REEL_SUMMARY_P95_MS || 220,
      220
    ),
    bootstrapFullP95Ms: toPositiveNumber(
      argv["bootstrap-p95-ms"] || process.env.FEED_SLO_BOOTSTRAP_FULL_P95_MS || 1200,
      1200
    ),
    max5xxPct: toNonNegativeNumber(
      argv["max-5xx-pct"] || process.env.FEED_SLO_MAX_5XX_PERCENT || 0.5,
      0.5
    ),
    max429Pct: toNonNegativeNumber(
      argv["max-429-pct"] || process.env.FEED_SLO_MAX_429_PERCENT || 4,
      4
    ),
    strict429: isTruthy(argv["strict-429"] || process.env.FEED_SLO_STRICT_429 || "0"),
    cacheMinSamples: toPositiveInt(
      argv["cache-min-samples"] || process.env.FEED_SLO_CACHE_MIN_SAMPLES || 100,
      100
    ),
    bootstrapHitMinPct: toNonNegativeNumber(
      argv["bootstrap-hit-min-pct"] || process.env.FEED_SLO_BOOTSTRAP_HIT_MIN_PERCENT || 55,
      55
    ),
    bootstrapNotifHitMinPct: toNonNegativeNumber(
      argv["bootstrap-notif-hit-min-pct"] ||
        process.env.FEED_SLO_BOOTSTRAP_NOTIF_HIT_MIN_PERCENT ||
        45,
      45
    ),
  };

  const headers = {
    "x-internal-debug": "true",
  };
  const token = String(process.env.INTERNAL_DEBUG_TOKEN || "").trim();
  if (token) headers["x-internal-debug-token"] = token;

  const started = nowMs();
  const url = `${endpoint}/internal/observability/overview?window=${windowSize}`;
  let response;
  try {
    response = await axios.get(url, {
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
    });
  } catch (error) {
    const output = {
      ok: false,
      strict,
      at: nowIso(),
      endpoint,
      url,
      duration_ms: round2(nowMs() - started),
      status: 0,
      error: String(error?.message || error),
      failures: [`request failed: ${String(error?.message || error)}`],
      warnings: [],
      checks: [],
    };
    if (asJson) console.log(JSON.stringify(output, null, 2));
    else console.log(`[feed-slo][FAIL] request failed: ${output.error}`);
    process.exit(1);
  }

  const observability = extractObservability(response.data);
  if (response.status !== 200 || !observability) {
    const output = {
      ok: false,
      strict,
      at: nowIso(),
      endpoint,
      url,
      duration_ms: round2(nowMs() - started),
      status: Number(response.status || 0),
      error: "invalid observability response",
      failures: [
        `observability endpoint status=${response.status} payload_missing=${observability ? "no" : "yes"}`,
      ],
      warnings: [],
      checks: [],
    };
    if (asJson) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(
        `[feed-slo][FAIL] observability endpoint status=${response.status} payload_missing=${
          observability ? "no" : "yes"
        }`
      );
    }
    process.exit(1);
  }

  const metrics = observability.response_metrics || {};
  const totals = metrics.totals || {};
  const bootstrapCache = metrics.bootstrap_cache || {};
  const bootstrapNotificationsCache = metrics.bootstrap_notifications_cache || {};
  const hotspotMap = buildHotspotMap(metrics.hotspots || []);
  const result = evaluate({
    totals,
    hotspotMap,
    bootstrapCache,
    bootstrapNotificationsCache,
    thresholds,
  });

  const output = {
    ok: result.failures.length === 0,
    strict,
    at: nowIso(),
    endpoint,
    url,
    duration_ms: round2(nowMs() - started),
    status: Number(response.status || 0),
    thresholds,
    global: result.global,
    checks: result.checks,
    failures: result.failures,
    warnings: result.warnings,
  };

  if (asJson) console.log(JSON.stringify(output, null, 2));
  else printHuman({ at: output.at, endpoint, thresholds, result });

  if (strict && result.failures.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});

