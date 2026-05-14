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

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const nowIso = () => new Date().toISOString();

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
  if (!trimmed) return "http://127.0.0.1:3000";
  return trimmed;
};

const extractObservability = (payload) => {
  const fromBody = payload?.body?.observability;
  if (fromBody && typeof fromBody === "object") return fromBody;
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

const evaluate = ({ totals, hotspotMap, thresholds }) => {
  const failures = [];
  const warnings = [];
  const checks = [];

  const requests = Number(totals?.requests || 0);
  const status4xx = Number(totals?.status_breakdown?.["4xx"] || 0);
  const status5xx = Number(totals?.status_breakdown?.["5xx"] || 0);
  const p95 = Number(totals?.p95_ms || 0);
  const p99 = Number(totals?.p99_ms || 0);
  const errorRate = Number(totals?.error_rate_percent || 0);
  const throttled429 = Number(totals?.throttled_429_rate_percent || 0);
  const rate4xx = requests > 0 ? round2((status4xx / requests) * 100) : 0;
  const rate5xx = requests > 0 ? round2((status5xx / requests) * 100) : 0;

  if (requests < thresholds.minWindowRequests) {
    const reason = `muestras globales insuficientes (${requests}/${thresholds.minWindowRequests})`;
    if (thresholds.requireTraffic) failures.push(reason);
    else warnings.push(reason);
  }

  if (rate5xx > thresholds.max5xxPct) {
    failures.push(`5xx global alto: ${rate5xx}% > max_5xx_percent=${thresholds.max5xxPct}%`);
  }

  if (throttled429 > thresholds.max429Pct) {
    const reason = `429 global alto: ${throttled429}% > max_429_percent=${thresholds.max429Pct}%`;
    if (thresholds.strict429) failures.push(reason);
    else warnings.push(reason);
  }

  if (rate4xx > thresholds.max4xxPct) {
    const reason = `4xx global alto: ${rate4xx}% > max_4xx_percent=${thresholds.max4xxPct}%`;
    if (thresholds.strict4xx) failures.push(reason);
    else warnings.push(reason);
  }

  const routeTargets = [
    {
      id: "chat_summary",
      key: metricKey("GET", "/api/v1/chat", true),
      label: "GET /api/v1/chat summary",
      p95BudgetMs: thresholds.chatSummaryP95Ms,
    },
    {
      id: "chat_messages_summary",
      key: metricKey("GET", "/api/v1/chat/message/:id", true),
      label: "GET /api/v1/chat/message/:id summary",
      p95BudgetMs: thresholds.chatMessageSummaryP95Ms,
    },
    {
      id: "chat_send_full",
      key: metricKey("POST", "/api/v1/chat", false),
      label: "POST /api/v1/chat full",
      p95BudgetMs: thresholds.chatSendP95Ms,
    },
    {
      id: "chat_list_full",
      key: metricKey("GET", "/api/v1/chat", false),
      label: "GET /api/v1/chat full",
      p95BudgetMs: thresholds.chatFullP95Ms,
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
      const reason = `muestras insuficientes (${count}/${thresholds.minRouteSamples})`;
      if (thresholds.requireTraffic) {
        check.status = "fail";
        check.reason = reason;
        failures.push(`${target.label}: ${reason}`);
      } else {
        check.status = "warning";
        check.reason = reason;
        warnings.push(`${target.label}: ${reason}`);
      }
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

  return {
    checks,
    failures,
    warnings,
    global: {
      requests,
      p95_ms: p95,
      p99_ms: p99,
      status_4xx: status4xx,
      status_5xx: status5xx,
      status_4xx_rate_percent: rate4xx,
      status_5xx_rate_percent: rate5xx,
      error_rate_percent: errorRate,
      throttled_429_rate_percent: throttled429,
    },
  };
};

const printHuman = ({ at, endpoint, thresholds, result }) => {
  console.log(`[chat-slo] at=${at}`);
  console.log(`[chat-slo] endpoint=${endpoint}`);
  console.log(
    `[chat-slo] global req=${result.global.requests} p95=${result.global.p95_ms}ms p99=${result.global.p99_ms}ms 4xx=${result.global.status_4xx_rate_percent}% 5xx=${result.global.status_5xx_rate_percent}% 429=${result.global.throttled_429_rate_percent}%`
  );
  for (const check of result.checks) {
    console.log(`[chat-slo] ${check.status.toUpperCase()} ${check.label}: ${check.reason}`);
  }
  console.log(
    `[chat-slo] thresholds p95(chat_summary=${thresholds.chatSummaryP95Ms}ms,chat_message_summary=${thresholds.chatMessageSummaryP95Ms}ms,chat_send=${thresholds.chatSendP95Ms}ms,chat_full=${thresholds.chatFullP95Ms}ms) max5xx=${thresholds.max5xxPct}% max429=${thresholds.max429Pct}% max4xx=${thresholds.max4xxPct}%`
  );
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.log(`[chat-slo][FAIL] ${failure}`);
    }
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`[chat-slo][WARN] ${warning}`);
    }
  }
  if (result.failures.length === 0 && result.warnings.length === 0) {
    console.log("[chat-slo] healthy");
  }
};

const main = async () => {
  loadEnv();
  const argv = parseArgs();

  const base = normalizeBaseUrl(
    argv["base-url"] || process.env.CHAT_SLO_BASE_URL || process.env.FEED_SLO_BASE_URL
  );
  const endpoint = `${base}/api/v1/internal/observability/overview`;
  const windowSize = toPositiveInt(argv.window || process.env.CHAT_SLO_WINDOW || 300, 300);
  const timeoutMs = toPositiveInt(
    argv["timeout-ms"] || process.env.CHAT_SLO_TIMEOUT_MS || 15000,
    15000
  );
  const strict = isTruthy(argv.strict || process.env.CHAT_SLO_STRICT || "1");
  const asJson = isTruthy(argv.json || process.env.CHAT_SLO_JSON || "0");
  const debugHeaderEnabled = isTruthy(
    argv["internal-debug"] || process.env.CHAT_SLO_INTERNAL_DEBUG || "1"
  );

  const thresholds = {
    minWindowRequests: toPositiveInt(
      argv["min-window-requests"] || process.env.CHAT_SLO_MIN_WINDOW_REQUESTS || 40,
      40
    ),
    minRouteSamples: toPositiveInt(
      argv["min-route-samples"] || process.env.CHAT_SLO_MIN_ROUTE_SAMPLES || 15,
      15
    ),
    chatSummaryP95Ms: toPositiveNumber(
      argv["chat-summary-p95-ms"] || process.env.CHAT_SLO_CHAT_SUMMARY_P95_MS || 220,
      220
    ),
    chatMessageSummaryP95Ms: toPositiveNumber(
      argv["chat-message-summary-p95-ms"] ||
        process.env.CHAT_SLO_CHAT_MESSAGE_SUMMARY_P95_MS ||
        130,
      130
    ),
    chatSendP95Ms: toPositiveNumber(
      argv["chat-send-p95-ms"] || process.env.CHAT_SLO_CHAT_SEND_P95_MS || 350,
      350
    ),
    chatFullP95Ms: toPositiveNumber(
      argv["chat-full-p95-ms"] || process.env.CHAT_SLO_CHAT_FULL_P95_MS || 600,
      600
    ),
    max5xxPct: toNonNegativeNumber(
      argv["max-5xx-percent"] || process.env.CHAT_SLO_MAX_5XX_PERCENT || 1,
      1
    ),
    max429Pct: toNonNegativeNumber(
      argv["max-429-percent"] || process.env.CHAT_SLO_MAX_429_PERCENT || 5,
      5
    ),
    max4xxPct: toNonNegativeNumber(
      argv["max-4xx-percent"] || process.env.CHAT_SLO_MAX_4XX_PERCENT || 35,
      35
    ),
    strict429: isTruthy(argv["strict-429"] || process.env.CHAT_SLO_STRICT_429 || "0"),
    strict4xx: isTruthy(argv["strict-4xx"] || process.env.CHAT_SLO_STRICT_4XX || "0"),
    requireTraffic: isTruthy(
      argv["require-traffic"] || process.env.CHAT_SLO_REQUIRE_TRAFFIC || "0"
    ),
  };

  const headers = {};
  if (debugHeaderEnabled) headers["x-internal-debug"] = "true";
  const internalToken = String(
    argv["internal-debug-token"] || process.env.CHAT_SLO_INTERNAL_DEBUG_TOKEN || process.env.INTERNAL_DEBUG_TOKEN || ""
  ).trim();
  if (internalToken) headers["x-internal-debug-token"] = internalToken;

  const at = nowIso();
  try {
    const response = await axios.get(endpoint, {
      params: { window: windowSize },
      headers,
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`observability request failed (status=${response.status})`);
    }

    const observability = extractObservability(response.data);
    if (!observability) {
      throw new Error("missing observability payload");
    }

    const responseMetrics = observability?.response_metrics || {};
    const totals = responseMetrics?.totals || {};
    const hotspotMap = buildHotspotMap(responseMetrics?.hotspots || []);
    const result = evaluate({ totals, hotspotMap, thresholds });
    const ok = result.failures.length === 0;

    const payload = {
      ok,
      strict,
      at,
      endpoint,
      config: {
        window: windowSize,
        timeout_ms: timeoutMs,
        thresholds,
      },
      global: result.global,
      checks: result.checks,
      failures: result.failures,
      warnings: result.warnings,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printHuman({ at, endpoint, thresholds, result });
    }

    if (strict && !ok) process.exit(1);
    process.exit(0);
  } catch (error) {
    const message = String(error?.message || error);
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            strict,
            at,
            endpoint,
            failures: [message],
          },
          null,
          2
        )
      );
    } else {
      console.error(`[chat-slo][FAIL] ${message}`);
    }
    process.exit(1);
  }
};

main();
