#!/usr/bin/env node

/* eslint-disable no-console */
const axios = require("axios");
const path = require("path");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const HIT_STATUSES = new Set(["HIT", "REVALIDATED", "UPDATING"]);
const DYNAMIC_STATUSES = new Set(["DYNAMIC", "BYPASS"]);

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const parseArgs = () => {
  const parsed = {};
  const argv = process.argv.slice(2);

  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] || "");
    if (!current.startsWith("--")) continue;

    const maybeEq = current.indexOf("=");
    if (maybeEq > 2) {
      const key = current.slice(2, maybeEq).trim();
      const value = current.slice(maybeEq + 1).trim();
      parsed[key] = value;
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

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const toNonNegativeInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const toRatio = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
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
  if (!trimmed) return "https://api.minhoo.xyz/api/v1";
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
};

const headerValue = (headers, key) => {
  const raw = headers?.[String(key || "").toLowerCase()];
  if (Array.isArray(raw)) return raw.join(", ");
  return String(raw ?? "").trim();
};

const nowIso = () => new Date().toISOString();
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

const isAuthTokenUsable = (tokenRaw) => {
  const token = String(tokenRaw || "").trim();
  if (!token) return false;
  if (token === "TU_TOKEN") return false;
  if (token.startsWith("CHANGE_ME")) return false;
  return true;
};

const requestSummary = async ({ url, authToken, timeoutMs }) => {
  const started = nowMs();
  try {
    const headers = {};
    if (authToken) headers.authorization = `Bearer ${authToken}`;

    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers,
      validateStatus: () => true,
    });

    return {
      ok: response.status >= 200 && response.status < 500,
      status: Number(response.status || 0),
      durationMs: Math.round((nowMs() - started) * 100) / 100,
      cfCacheStatus: headerValue(response.headers, "cf-cache-status").toUpperCase(),
      xSummaryCache: headerValue(response.headers, "x-summary-cache").toLowerCase(),
      vary: headerValue(response.headers, "vary"),
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round((nowMs() - started) * 100) / 100,
      cfCacheStatus: "",
      xSummaryCache: "",
      vary: "",
      error: String(error?.message || error),
    };
  }
};

const isSummaryHit = (result) => {
  const cfStatus = String(result?.cfCacheStatus || "").toUpperCase();
  const summaryStatus = String(result?.xSummaryCache || "").toLowerCase();
  return HIT_STATUSES.has(cfStatus) || summaryStatus === "hit" || summaryStatus === "coalesced";
};

const isSummaryDynamic = (result) => {
  const cfStatus = String(result?.cfCacheStatus || "").toUpperCase();
  const summaryStatus = String(result?.xSummaryCache || "").toLowerCase();
  return DYNAMIC_STATUSES.has(cfStatus) || summaryStatus === "bypass";
};

const formatPct = (num, den) => {
  if (!den) return "0.0%";
  return `${((num / den) * 100).toFixed(1)}%`;
};

const ratio = (num, den) => {
  if (!den) return 0;
  return num / den;
};

const sleep = async (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runCycle = async ({ baseUrl, size, timeoutMs, authToken }) => {
  const endpoints = [
    { name: "post", path: "/post" },
    { name: "reel", path: "/reel" },
  ];

  const cycleStamp = Date.now();
  const results = [];

  for (const endpoint of endpoints) {
    const probe = `${cycleStamp}-${endpoint.name}`;
    const url = `${baseUrl}${endpoint.path}?summary=1&size=${size}&probe=${encodeURIComponent(
      probe
    )}`;

    const anon1 = await requestSummary({ url, timeoutMs, authToken: "" });
    const anon2 = await requestSummary({ url, timeoutMs, authToken: "" });
    const auth = authToken
      ? await requestSummary({ url, timeoutMs, authToken })
      : null;

    results.push({
      endpoint: endpoint.name,
      url,
      anon1,
      anon2,
      auth,
      anonSecondHit: isSummaryHit(anon2),
      authDynamic: auth ? isSummaryDynamic(auth) : null,
    });
  }

  return {
    at: nowIso(),
    results,
  };
};

const printCycle = ({ cycleIndex, cycleData, totals, asJson }) => {
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          cycle: cycleIndex,
          at: cycleData.at,
          endpoints: cycleData.results,
          totals,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n[cache-monitor] cycle=${cycleIndex} at=${cycleData.at}`);
  for (const row of cycleData.results) {
    const anon1 = `anon1 cf=${row.anon1.cfCacheStatus || "-"} x=${row.anon1.xSummaryCache || "-"} s=${row.anon1.status}`;
    const anon2 = `anon2 cf=${row.anon2.cfCacheStatus || "-"} x=${row.anon2.xSummaryCache || "-"} s=${row.anon2.status}`;
    const auth = row.auth
      ? `auth cf=${row.auth.cfCacheStatus || "-"} x=${row.auth.xSummaryCache || "-"} s=${row.auth.status}`
      : "auth skipped";
    const total = totals[row.endpoint];

    console.log(`  ${row.endpoint}: ${anon1} | ${anon2} | ${auth}`);
    console.log(
      `  ${row.endpoint}: anon_hit=${formatPct(
        total.anonSecondHit,
        total.cycles
      )} (${total.anonSecondHit}/${total.cycles}) auth_dynamic=${formatPct(
        total.authDynamic,
        total.authChecks
      )} (${total.authDynamic}/${total.authChecks})`
    );
  }
};

const main = async () => {
  loadEnv();
  const argv = parseArgs();

  const baseUrl = normalizeBaseUrl(
    argv["base-url"] || process.env.CACHE_MONITOR_BASE_URL || process.env.SMOKE_BASE_URL
  );
  const timeoutMs = toPositiveInt(argv["timeout-ms"] || process.env.CACHE_MONITOR_TIMEOUT_MS, 15000);
  const size = Math.min(
    20,
    Math.max(1, toPositiveInt(argv.size || process.env.CACHE_MONITOR_SIZE, 20))
  );
  const intervalSeconds = toNonNegativeInt(
    argv["interval-seconds"] || process.env.CACHE_MONITOR_INTERVAL_SECONDS,
    0
  );
  const configuredCycles = toNonNegativeInt(argv.cycles || process.env.CACHE_MONITOR_CYCLES, 1);
  const asJson = isTruthy(argv.json || process.env.CACHE_MONITOR_JSON);
  const strict = isTruthy(argv.strict || process.env.CACHE_MONITOR_STRICT);
  const minAnonHit = toRatio(
    argv["min-anon-hit"] || process.env.CACHE_MONITOR_MIN_ANON_HIT,
    1
  );
  const minAuthDynamic = toRatio(
    argv["min-auth-dynamic"] || process.env.CACHE_MONITOR_MIN_AUTH_DYNAMIC,
    1
  );

  const rawAuthToken =
    argv["auth-token"] ||
    process.env.CACHE_MONITOR_AUTH_TOKEN ||
    process.env.SMOKE_AUTH_TOKEN ||
    "";
  const authToken = isAuthTokenUsable(rawAuthToken) ? String(rawAuthToken).trim() : "";

  const totals = {
    post: { cycles: 0, anonSecondHit: 0, authChecks: 0, authDynamic: 0, requestErrors: 0 },
    reel: { cycles: 0, anonSecondHit: 0, authChecks: 0, authDynamic: 0, requestErrors: 0 },
  };

  let cycleIndex = 0;
  const infinite = intervalSeconds > 0 && configuredCycles === 0;
  const maxCycles = infinite ? Number.MAX_SAFE_INTEGER : Math.max(1, configuredCycles);

  do {
    cycleIndex += 1;
    const cycleData = await runCycle({
      baseUrl,
      size,
      timeoutMs,
      authToken,
    });

    for (const row of cycleData.results) {
      const bucket = totals[row.endpoint];
      if (!bucket) continue;
      bucket.cycles += 1;
      if (row.anonSecondHit) bucket.anonSecondHit += 1;
      if (!row.anon1.ok || row.anon1.status < 200 || row.anon1.status >= 300) bucket.requestErrors += 1;
      if (!row.anon2.ok || row.anon2.status < 200 || row.anon2.status >= 300) bucket.requestErrors += 1;
      if (row.auth) {
        bucket.authChecks += 1;
        if (row.authDynamic) bucket.authDynamic += 1;
        if (!row.auth.ok || row.auth.status < 200 || row.auth.status >= 300) bucket.requestErrors += 1;
      }
    }

    printCycle({
      cycleIndex,
      cycleData,
      totals,
      asJson,
    });

    if (cycleIndex >= maxCycles) break;
    if (intervalSeconds <= 0) break;

    await sleep(intervalSeconds * 1000);
  } while (true);

  const failures = [];
  for (const [endpoint, total] of Object.entries(totals)) {
    const anonHitRatio = ratio(total.anonSecondHit, total.cycles);
    const authDynamicRatio = ratio(total.authDynamic, total.authChecks);
    if (total.requestErrors > 0) {
      failures.push(`${endpoint}: request_errors=${total.requestErrors}`);
    }
    if (anonHitRatio < minAnonHit) {
      failures.push(
        `${endpoint}: anon_hit_ratio=${anonHitRatio.toFixed(3)} < min_anonymous=${minAnonHit.toFixed(3)}`
      );
    }
    if (total.authChecks > 0 && authDynamicRatio < minAuthDynamic) {
      failures.push(
        `${endpoint}: auth_dynamic_ratio=${authDynamicRatio.toFixed(3)} < min_auth_dynamic=${minAuthDynamic.toFixed(3)}`
      );
    }
  }

  if (!asJson) {
    console.log(
      `[cache-monitor] strict=${strict ? "on" : "off"} min_anon_hit=${minAnonHit} min_auth_dynamic=${minAuthDynamic}`
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        console.log(`[cache-monitor][WARN] ${failure}`);
      }
    } else {
      console.log("[cache-monitor] healthy");
    }
  }

  if (strict && failures.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
