#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
};

const toNonNegativeInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

const toNonNegativeNumber = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const pct = (part, total) => {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return (p / t) * 100;
};

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

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

const getConnectionConfig = () => {
  const host = String(process.env.DB_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const user = String(process.env.USER_DB || process.env.DB_USER || "").trim();
  const password = String(process.env.DB_PASSWORD || "").trim();
  const database = String(process.env.DB || "").trim();
  const port = toPositiveInt(process.env.DB_PORT, 3306);
  const connectTimeout = toPositiveInt(process.env.DB_CONNECT_TIMEOUT_MS, 10000);

  if (!user || !database) {
    throw new Error("missing DB credentials (USER_DB/DB and DB_PASSWORD)");
  }

  return {
    host,
    user,
    password,
    database,
    port,
    connectTimeout,
    timezone: "Z",
  };
};

const summarizeByEndpoint = (rows) => {
  const summary = {};
  for (const row of rows || []) {
    const endpoint = String(row.endpoint || "").trim() || "unknown";
    summary[endpoint] = {
      total: Number(row.total || 0),
      processing: Number(row.processing || 0),
      processing_stuck: Number(row.processing_stuck || 0),
      conflicts_409: Number(row.conflicts_409 || 0),
      success_2xx: Number(row.success_2xx || 0),
      server_5xx: Number(row.server_5xx || 0),
    };
  }
  return summary;
};

const main = async () => {
  loadEnv();

  const strict = isTruthy(process.env.IDEMP_MONITOR_STRICT ?? "1");
  const json = isTruthy(process.env.IDEMP_MONITOR_JSON ?? "0");
  const lookbackMinutes = toPositiveInt(process.env.IDEMP_MONITOR_LOOKBACK_MINUTES, 30);
  const stuckMinutes = toPositiveInt(process.env.IDEMP_MONITOR_STUCK_MINUTES, 10);
  const maxStuck = toNonNegativeInt(process.env.IDEMP_MONITOR_MAX_STUCK, 0);
  const minSamples = toNonNegativeInt(process.env.IDEMP_MONITOR_MIN_SAMPLES, 5);
  const maxConflictRatePct = toNonNegativeNumber(
    process.env.IDEMP_MONITOR_MAX_CONFLICT_RATE_PCT,
    60
  );
  const maxServerErrorRatePct = toNonNegativeNumber(
    process.env.IDEMP_MONITOR_MAX_SERVER_ERROR_RATE_PCT,
    10
  );
  const requireRecentActivity = isTruthy(
    process.env.IDEMP_MONITOR_REQUIRE_RECENT_ACTIVITY ?? "0"
  );

  const now = new Date().toISOString();
  let connection;
  const checks = [];
  const failures = [];
  const warnings = [];

  try {
    connection = await mysql.createConnection(getConnectionConfig());

    const [tableRows] = await connection.query(
      `
        SELECT COUNT(*) AS table_exists
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name = 'content_idempotency'
      `,
      [String(process.env.DB || "").trim()]
    );
    const tableExists = Number(tableRows?.[0]?.table_exists || 0) > 0;
    if (!tableExists) {
      const message = "table content_idempotency not found";
      checks.push({ status: "fail", label: "table_exists", reason: message });
      failures.push(message);
      const payload = {
        ok: false,
        at: now,
        checks,
        failures,
        warnings,
      };
      if (json) console.log(JSON.stringify(payload, null, 2));
      else console.log(`[idempotency-monitor][FAIL] ${message}`);
      process.exit(1);
      return;
    }

    const [aggregateRows] = await connection.query(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(
            CASE
              WHEN status = 'processing'
               AND updatedAt < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
              THEN 1 ELSE 0
            END
          ) AS processing_stuck,
          SUM(CASE WHEN response_status = 409 THEN 1 ELSE 0 END) AS conflicts_409,
          SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success_2xx,
          SUM(CASE WHEN response_status >= 500 THEN 1 ELSE 0 END) AS server_5xx
        FROM content_idempotency
        WHERE updatedAt >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
      `,
      [stuckMinutes, lookbackMinutes]
    );

    const [endpointRows] = await connection.query(
      `
        SELECT
          endpoint,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(
            CASE
              WHEN status = 'processing'
               AND updatedAt < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
              THEN 1 ELSE 0
            END
          ) AS processing_stuck,
          SUM(CASE WHEN response_status = 409 THEN 1 ELSE 0 END) AS conflicts_409,
          SUM(CASE WHEN response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success_2xx,
          SUM(CASE WHEN response_status >= 500 THEN 1 ELSE 0 END) AS server_5xx
        FROM content_idempotency
        WHERE updatedAt >= (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
        GROUP BY endpoint
        ORDER BY endpoint
      `,
      [stuckMinutes, lookbackMinutes]
    );

    const aggregate = {
      total: Number(aggregateRows?.[0]?.total || 0),
      completed: Number(aggregateRows?.[0]?.completed || 0),
      processing: Number(aggregateRows?.[0]?.processing || 0),
      processing_stuck: Number(aggregateRows?.[0]?.processing_stuck || 0),
      conflicts_409: Number(aggregateRows?.[0]?.conflicts_409 || 0),
      success_2xx: Number(aggregateRows?.[0]?.success_2xx || 0),
      server_5xx: Number(aggregateRows?.[0]?.server_5xx || 0),
    };
    const byEndpoint = summarizeByEndpoint(endpointRows);
    const expectedEndpoints = ["/api/v1/post", "/api/v1/reel"];

    if (aggregate.processing_stuck > maxStuck) {
      const reason = `stuck processing rows=${aggregate.processing_stuck} max=${maxStuck} age>${stuckMinutes}m`;
      checks.push({ status: "fail", label: "stuck_processing", reason });
      failures.push(reason);
    } else {
      checks.push({
        status: "ok",
        label: "stuck_processing",
        reason: `stuck=${aggregate.processing_stuck} max=${maxStuck}`,
      });
    }

    const hasEnoughSamples = aggregate.total >= minSamples;
    if (!hasEnoughSamples) {
      const reason = `samples below threshold (${aggregate.total}/${minSamples})`;
      checks.push({ status: "warn", label: "sample_size", reason });
      warnings.push(reason);
    } else {
      checks.push({ status: "ok", label: "sample_size", reason: `samples=${aggregate.total}` });
    }

    const conflictRatePct = round2(pct(aggregate.conflicts_409, aggregate.total));
    if (hasEnoughSamples && conflictRatePct > maxConflictRatePct) {
      const reason = `conflict rate ${conflictRatePct}% exceeds ${maxConflictRatePct}%`;
      checks.push({ status: "fail", label: "conflict_rate", reason });
      failures.push(reason);
    } else {
      checks.push({
        status: hasEnoughSamples ? "ok" : "warn",
        label: "conflict_rate",
        reason: `conflicts=${aggregate.conflicts_409}/${aggregate.total} (${conflictRatePct}%)`,
      });
    }

    const serverErrorRatePct = round2(pct(aggregate.server_5xx, aggregate.total));
    if (hasEnoughSamples && serverErrorRatePct > maxServerErrorRatePct) {
      const reason = `server error rate ${serverErrorRatePct}% exceeds ${maxServerErrorRatePct}%`;
      checks.push({ status: "fail", label: "server_error_rate", reason });
      failures.push(reason);
    } else {
      checks.push({
        status: hasEnoughSamples ? "ok" : "warn",
        label: "server_error_rate",
        reason: `server_5xx=${aggregate.server_5xx}/${aggregate.total} (${serverErrorRatePct}%)`,
      });
    }

    for (const endpoint of expectedEndpoints) {
      const count = Number(byEndpoint?.[endpoint]?.total || 0);
      if (count <= 0 && requireRecentActivity) {
        const reason = `no recent idempotency activity for ${endpoint}`;
        checks.push({ status: "fail", label: `endpoint_activity:${endpoint}`, reason });
        failures.push(reason);
      } else if (count <= 0) {
        const reason = `no recent activity for ${endpoint} (allowed)`;
        checks.push({ status: "warn", label: `endpoint_activity:${endpoint}`, reason });
        warnings.push(reason);
      } else {
        checks.push({
          status: "ok",
          label: `endpoint_activity:${endpoint}`,
          reason: `events=${count}`,
        });
      }
    }

    const ok = failures.length === 0;
    const payload = {
      ok,
      strict,
      at: now,
      config: {
        lookback_minutes: lookbackMinutes,
        stuck_minutes: stuckMinutes,
        max_stuck: maxStuck,
        min_samples: minSamples,
        max_conflict_rate_pct: maxConflictRatePct,
        max_server_error_rate_pct: maxServerErrorRatePct,
        require_recent_activity: requireRecentActivity,
      },
      aggregate: {
        ...aggregate,
        conflict_rate_pct: conflictRatePct,
        server_error_rate_pct: serverErrorRatePct,
      },
      by_endpoint: byEndpoint,
      checks,
      failures,
      warnings,
    };

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`[idempotency-monitor] at=${now}`);
      console.log(
        `[idempotency-monitor] total=${aggregate.total} completed=${aggregate.completed} processing=${aggregate.processing} stuck=${aggregate.processing_stuck}`
      );
      console.log(
        `[idempotency-monitor] conflict_rate=${conflictRatePct}% server_error_rate=${serverErrorRatePct}%`
      );
      for (const check of checks) {
        console.log(
          `[idempotency-monitor] ${String(check.status || "").toUpperCase()} ${check.label}: ${check.reason}`
        );
      }
      if (ok) console.log("[idempotency-monitor] healthy");
    }

    if (strict && !ok) process.exit(1);
    process.exit(0);
  } catch (error) {
    const message = String(error?.message || error);
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            strict,
            at: now,
            failures: [message],
          },
          null,
          2
        )
      );
    } else {
      console.error(`[idempotency-monitor][FAIL] ${message}`);
    }
    process.exit(1);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (_err) {
        // ignore close errors
      }
    }
  }
};

main();
