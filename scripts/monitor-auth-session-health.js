#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const mysql = require("mysql2/promise");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const AUTH_ERROR_MARKER = "[auth-error]";
const LOGIN_MARKER = "[perf][login]";
const FILE_PLACEHOLDER_RE = /^__USE_.*_FILE__$/;
const STARTUP_PROTECTED_ROUTE_HINTS = [
  "/api/v1/auth/session/validate",
  "/api/v1/auth/device-token",
  "/api/v1/user/mydata",
  "/api/v1/user/profile",
  "/api/v1/user/visibility",
  "/api/v1/worker",
];

const toPositiveInt = (value, fallback, min = 1) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.trunc(n);
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

const parseLowerSet = (raw, fallback = []) => {
  const value = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (value.length) return new Set(value);
  return new Set(
    (Array.isArray(fallback) ? fallback : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  );
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

const resolveLogFiles = (logsDir, explicitListRaw) => {
  const explicitList = String(explicitListRaw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicitList.length) {
    return explicitList.map((entry) => {
      if (path.isAbsolute(entry)) return entry;
      return path.resolve(logsDir, entry);
    });
  }

  if (!fs.existsSync(logsDir)) return [];

  return fs
    .readdirSync(logsDir)
    .filter((fileName) => /^(app_.*\.out|.*\.log)$/i.test(fileName))
    .map((fileName) => path.resolve(logsDir, fileName))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch (_error) {
        return false;
      }
    });
};

const parseTimestampMsFromLine = (line) => {
  const isoMatch = String(line || "").match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/
  );
  if (isoMatch?.[1]) {
    const ms = Date.parse(isoMatch[1]);
    if (Number.isFinite(ms)) return ms;
  }

  const basicMatch = String(line || "").match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (basicMatch?.[1]) {
    const ms = Date.parse(`${basicMatch[1].replace(" ", "T")}Z`);
    if (Number.isFinite(ms)) return ms;
  }

  return null;
};

const parseAuthErrorFromLine = (line) => {
  const markerIdx = line.indexOf(AUTH_ERROR_MARKER);
  if (markerIdx < 0) return null;
  const rawAfterMarker = line.slice(markerIdx + AUTH_ERROR_MARKER.length).trim();
  const jsonMatch = rawAfterMarker.match(/\{.*\}/);
  if (!jsonMatch?.[0]) return null;

  try {
    const payload = JSON.parse(jsonMatch[0]);
    return {
      code: String(payload?.code || "UNKNOWN").trim() || "UNKNOWN",
      status: Number(payload?.status || 0),
      method: String(payload?.method || "").trim().toUpperCase(),
      route: String(payload?.route || "").trim(),
      authenticated: Boolean(payload?.authenticated),
      userId: Number(payload?.user_id || 0) || null,
      retryable: Boolean(payload?.retryable),
      appVersion: String(payload?.app_version || "unknown").trim().toLowerCase() || "unknown",
      appBuild: String(payload?.app_build || "unknown").trim().toLowerCase() || "unknown",
      platform: String(payload?.platform || "unknown").trim().toLowerCase() || "unknown",
      deviceFp: String(payload?.device_fp || "dev:unknown").trim().toLowerCase() || "dev:unknown",
      sessionFp: String(payload?.session_fp || "sess:unknown").trim().toLowerCase() || "sess:unknown",
    };
  } catch (_error) {
    return null;
  }
};

const parseLoginFromLine = (line) => {
  if (!line.includes(LOGIN_MARKER)) return null;
  const match = line.match(/\[perf\]\[login\]\s+email=([^\s]+)\s+totalMs=(\d+)/i);
  if (!match) return null;
  return {
    email: String(match[1] || "")
      .trim()
      .toLowerCase(),
    totalMs: Number(match[2] || 0),
  };
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

  if (FILE_PLACEHOLDER_RE.test(password)) {
    const filePath = String(process.env.DB_PASSWORD_FILE || "").trim();
    const hint = filePath
      ? `DB_PASSWORD unresolved from DB_PASSWORD_FILE (${filePath})`
      : "DB_PASSWORD unresolved from file-backed secret";
    throw new Error(`${hint}. Run with a user that can read secrets or export DB_PASSWORD.`);
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

const checkSessionsTableExists = async (connection) => {
  const [rows] = await connection.query(
    `
      SELECT COUNT(*) AS table_exists
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_name = 'user_auth_sessions'
    `,
    [String(process.env.DB || "").trim()]
  );
  return Number(rows?.[0]?.table_exists || 0) > 0;
};

const checkRevokedReasonColumnExists = async (connection) => {
  const [rows] = await connection.query(
    `
      SELECT COUNT(*) AS column_exists
      FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = 'user_auth_sessions'
        AND column_name = 'revoked_reason'
    `,
    [String(process.env.DB || "").trim()]
  );
  return Number(rows?.[0]?.column_exists || 0) > 0;
};

const getSessionStats = async (
  connection,
  windowHours,
  hasRevokedReasonColumn,
  ignoredRevokedReasons
) => {
  const [rows] = await connection.query(
    `
      SELECT
        SUM(CASE WHEN created_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) THEN 1 ELSE 0 END) AS created_window,
        SUM(CASE WHEN revoked_at IS NOT NULL AND revoked_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR) THEN 1 ELSE 0 END) AS revoked_window,
        SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at >= UTC_TIMESTAMP()) THEN 1 ELSE 0 END) AS active_now
      FROM user_auth_sessions
    `,
    [windowHours, windowHours]
  );

  const revokedWindow = Number(rows?.[0]?.revoked_window || 0);
  let reasonRows = [];
  if (hasRevokedReasonColumn) {
    const [dbReasonRows] = await connection.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(revoked_reason), ''), 'unknown') AS reason,
          COUNT(*) AS count
        FROM user_auth_sessions
        WHERE revoked_at IS NOT NULL
          AND revoked_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
        GROUP BY COALESCE(NULLIF(TRIM(revoked_reason), ''), 'unknown')
        ORDER BY count DESC
        LIMIT 12
      `,
      [windowHours]
    );
    reasonRows = Array.isArray(dbReasonRows) ? dbReasonRows : [];
  } else if (revokedWindow > 0) {
    reasonRows = [{ reason: "unknown", count: revokedWindow }];
  }

  const normalizedReasonRows = (Array.isArray(reasonRows) ? reasonRows : []).map((row) => ({
    reason: String(row?.reason || "unknown").trim().toLowerCase() || "unknown",
    count: Number(row?.count || 0),
  }));
  const ignoredReasons = ignoredRevokedReasons instanceof Set ? ignoredRevokedReasons : new Set();
  let revokedExpectedWindow = 0;
  let revokedUnexpectedWindow = 0;
  for (const row of normalizedReasonRows) {
    if (ignoredReasons.has(row.reason)) revokedExpectedWindow += Number(row.count || 0);
    else revokedUnexpectedWindow += Number(row.count || 0);
  }
  // Fallback when reasons are missing or partial.
  if (hasRevokedReasonColumn && normalizedReasonRows.length > 0) {
    const covered = revokedExpectedWindow + revokedUnexpectedWindow;
    if (covered < revokedWindow) revokedUnexpectedWindow += revokedWindow - covered;
  }
  if (!hasRevokedReasonColumn) {
    revokedExpectedWindow = 0;
    revokedUnexpectedWindow = revokedWindow;
  }

  return {
    createdWindow: Number(rows?.[0]?.created_window || 0),
    revokedWindow,
    activeNow: Number(rows?.[0]?.active_now || 0),
    revokedExpectedWindow,
    revokedUnexpectedWindow,
    revokedReasons: normalizedReasonRows,
  };
};

const runAuthSessionMonitor = async (options = {}) => {
  if (!options.skipLoadEnv) {
    loadEnv();
  }

  const strict =
    options.strictOverride !== undefined
      ? Boolean(options.strictOverride)
      : isTruthy(process.env.AUTH_MONITOR_STRICT ?? "1");
  const json =
    options.jsonOverride !== undefined
      ? Boolean(options.jsonOverride)
      : isTruthy(process.env.AUTH_MONITOR_JSON ?? "0");
  const windowHours = toPositiveInt(process.env.AUTH_MONITOR_WINDOW_HOURS, 24);
  const quickReloginMinutes = toPositiveInt(
    process.env.AUTH_MONITOR_QUICK_RELOGIN_MINUTES,
    20
  );
  const minAuthErrorSamples = toPositiveInt(process.env.AUTH_MONITOR_MIN_AUTH_ERROR_SAMPLES, 10);
  const minDbSamples = toPositiveInt(process.env.AUTH_MONITOR_MIN_DB_SAMPLES, 20);
  const minUniqueLoginUsers = toPositiveInt(
    process.env.AUTH_MONITOR_MIN_UNIQUE_LOGIN_USERS,
    10
  );
  const maxHardLogoutErrorPct = toNonNegativeNumber(
    process.env.AUTH_MONITOR_MAX_HARD_LOGOUT_ERROR_PCT,
    65
  );
  const maxRevokedSessionRatePct = toNonNegativeNumber(
    process.env.AUTH_MONITOR_MAX_REVOKED_SESSION_RATE_PCT,
    35
  );
  const ignoredRevokedReasons = parseLowerSet(
    process.env.AUTH_MONITOR_REVOKED_IGNORE_REASONS,
    [
      "session_cap_prune",
      "device_rotation_access",
      "device_rotation_refresh",
      "refresh_rotation",
    ]
  );
  const maxQuickReloginUserRatePct = toNonNegativeNumber(
    process.env.AUTH_MONITOR_MAX_QUICK_RELOGIN_USER_RATE_PCT,
    12
  );
  const logsDir = path.resolve(
    ROOT_DIR,
    String(process.env.AUTH_MONITOR_LOG_DIR || "logs").trim()
  );
  const windowStartMs = Date.now() - windowHours * 60 * 60 * 1000;

  const logFiles = resolveLogFiles(logsDir, process.env.AUTH_MONITOR_LOG_FILES);
  const authErrors = [];
  const loginEvents = [];
  const logWarnings = [];
  let scannedLines = 0;

  for (const logFile of logFiles) {
    let fileMtimeMs = Date.now();
    try {
      fileMtimeMs = fs.statSync(logFile).mtimeMs || Date.now();
    } catch (_error) {
      // noop
    }

    let content = "";
    try {
      content = fs.readFileSync(logFile, "utf8");
    } catch (error) {
      logWarnings.push(`could not read log file ${logFile}: ${String(error?.message || error)}`);
      continue;
    }

    const lines = content.split(/\r?\n/);
    scannedLines += lines.length;

    for (const line of lines) {
      if (!line) continue;
      const lineTimestampMs = parseTimestampMsFromLine(line);
      const hasTimeSignal = Number.isFinite(lineTimestampMs) || Number.isFinite(fileMtimeMs);
      const effectiveTimestamp = Number.isFinite(lineTimestampMs) ? lineTimestampMs : fileMtimeMs;
      if (hasTimeSignal && effectiveTimestamp < windowStartMs) continue;

      const authError = parseAuthErrorFromLine(line);
      if (authError) authErrors.push(authError);

      const login = parseLoginFromLine(line);
      if (login && login.email) {
        loginEvents.push({
          ...login,
          timestampMs: effectiveTimestamp,
        });
      }
    }
  }

  const authCodeCounts = {};
  const routeCounts = {};
  const appVersionCounts = {};
  const appBuildCounts = {};
  const platformCounts = {};
  const deviceFpCounts = {};
  const hardLogoutByAppVersion = {};
  let startup401Total = 0;
  let startup401HardLogout = 0;
  let startup401Retryable = 0;
  const startup401ByRoute = {};

  const registerCount = (bucket, key) => {
    const normalized = String(key || "unknown").trim().toLowerCase() || "unknown";
    bucket[normalized] = Number(bucket[normalized] || 0) + 1;
  };

  for (const event of authErrors) {
    authCodeCounts[event.code] = Number(authCodeCounts[event.code] || 0) + 1;
    const routeKey = `${event.method || "UNK"} ${event.route || "unknown"}`.trim();
    routeCounts[routeKey] = Number(routeCounts[routeKey] || 0) + 1;
    registerCount(appVersionCounts, event.appVersion);
    registerCount(appBuildCounts, event.appBuild);
    registerCount(platformCounts, event.platform);
    registerCount(deviceFpCounts, event.deviceFp);

    const routeLower = String(event.route || "").trim().toLowerCase();
    const isStartupProtectedRoute = STARTUP_PROTECTED_ROUTE_HINTS.some((hint) =>
      routeLower.startsWith(hint)
    );
    if (event.status === 401 && isStartupProtectedRoute) {
      startup401Total += 1;
      registerCount(startup401ByRoute, `${event.method || "UNK"} ${routeLower}`);
      if (event.retryable) startup401Retryable += 1;
      if (
        event.code === "AUTH_TOKEN_INVALID" ||
        event.code === "AUTH_SESSION_REVOKED"
      ) {
        startup401HardLogout += 1;
      }
    }

    if (
      event.code === "AUTH_TOKEN_INVALID" ||
      event.code === "AUTH_SESSION_REVOKED"
    ) {
      registerCount(hardLogoutByAppVersion, event.appVersion);
    }
  }

  const hardLogoutErrors =
    Number(authCodeCounts.AUTH_TOKEN_INVALID || 0) +
    Number(authCodeCounts.AUTH_SESSION_REVOKED || 0);
  const hardLogoutErrorPct = round2(pct(hardLogoutErrors, authErrors.length));

  const byEmail = {};
  for (const event of loginEvents) {
    if (!Array.isArray(byEmail[event.email])) byEmail[event.email] = [];
    byEmail[event.email].push(event);
  }

  const quickReloginEmails = new Set();
  for (const email of Object.keys(byEmail)) {
    const events = byEmail[email]
      .filter((item) => Number.isFinite(item.timestampMs))
      .sort((a, b) => a.timestampMs - b.timestampMs);
    for (let i = 1; i < events.length; i += 1) {
      const diffMs = events[i].timestampMs - events[i - 1].timestampMs;
      if (diffMs >= 0 && diffMs <= quickReloginMinutes * 60 * 1000) {
        quickReloginEmails.add(email);
        break;
      }
    }
  }

  const uniqueLoginUsers = Object.keys(byEmail).length;
  const quickReloginUserRatePct = round2(
    pct(quickReloginEmails.size, Math.max(1, uniqueLoginUsers))
  );

  const checks = [];
  const failures = [];
  const warnings = [...logWarnings];

  if (!logFiles.length) {
    warnings.push(`no log files found in ${logsDir}`);
  }

  if (authErrors.length >= minAuthErrorSamples && hardLogoutErrorPct > maxHardLogoutErrorPct) {
    const reason = `hard logout auth errors ${hardLogoutErrorPct}% > ${maxHardLogoutErrorPct}%`;
    checks.push({ status: "fail", label: "auth_hard_logout_rate", reason });
    failures.push(reason);
  } else {
    checks.push({
      status: authErrors.length >= minAuthErrorSamples ? "ok" : "warn",
      label: "auth_hard_logout_rate",
      reason: `hard_logout=${hardLogoutErrors}/${authErrors.length} (${hardLogoutErrorPct}%)`,
    });
    if (authErrors.length < minAuthErrorSamples) {
      warnings.push(
        `auth-error samples below threshold (${authErrors.length}/${minAuthErrorSamples})`
      );
    }
  }

  if (
    uniqueLoginUsers >= minUniqueLoginUsers &&
    quickReloginUserRatePct > maxQuickReloginUserRatePct
  ) {
    const reason = `quick relogin users ${quickReloginUserRatePct}% > ${maxQuickReloginUserRatePct}%`;
    checks.push({ status: "fail", label: "quick_relogin_rate", reason });
    failures.push(reason);
  } else {
    checks.push({
      status: uniqueLoginUsers >= minUniqueLoginUsers ? "ok" : "warn",
      label: "quick_relogin_rate",
      reason: `quick_relogin_users=${quickReloginEmails.size}/${uniqueLoginUsers} (${quickReloginUserRatePct}%)`,
    });
    if (uniqueLoginUsers < minUniqueLoginUsers) {
      warnings.push(
        `unique login users below threshold (${uniqueLoginUsers}/${minUniqueLoginUsers})`
      );
    }
  }

  let dbSummary = {
    enabled: true,
    available: false,
    tableExists: false,
    createdWindow: 0,
    revokedWindow: 0,
    revokedExpectedWindow: 0,
    revokedUnexpectedWindow: 0,
    activeNow: 0,
    revokedSessionRatePct: 0,
    revokedUnexpectedSessionRatePct: 0,
    revokedReasonColumn: false,
    revokedReasonCounts: [],
    revokedIgnoredReasons: Array.from(ignoredRevokedReasons),
    error: "",
  };

  let connection = null;
  try {
    connection = await mysql.createConnection(getConnectionConfig());
    dbSummary.available = true;
    dbSummary.tableExists = await checkSessionsTableExists(connection);
    if (!dbSummary.tableExists) {
      warnings.push("table user_auth_sessions not found");
    } else {
      dbSummary.revokedReasonColumn = await checkRevokedReasonColumnExists(connection);
      const stats = await getSessionStats(
        connection,
        windowHours,
        dbSummary.revokedReasonColumn,
        ignoredRevokedReasons
      );
      dbSummary.createdWindow = stats.createdWindow;
      dbSummary.revokedWindow = stats.revokedWindow;
      dbSummary.revokedExpectedWindow = stats.revokedExpectedWindow;
      dbSummary.revokedUnexpectedWindow = stats.revokedUnexpectedWindow;
      dbSummary.activeNow = stats.activeNow;
      dbSummary.revokedReasonCounts = Array.isArray(stats.revokedReasons)
        ? stats.revokedReasons
        : [];
      if (!dbSummary.revokedReasonColumn) {
        warnings.push("column user_auth_sessions.revoked_reason not found (using unknown bucket)");
      }
      dbSummary.revokedSessionRatePct = round2(
        pct(stats.revokedWindow, Math.max(1, stats.createdWindow))
      );
      dbSummary.revokedUnexpectedSessionRatePct = round2(
        pct(stats.revokedUnexpectedWindow, Math.max(1, stats.createdWindow))
      );

      if (
        stats.createdWindow >= minDbSamples &&
        dbSummary.revokedUnexpectedSessionRatePct > maxRevokedSessionRatePct
      ) {
        const reason = `unexpected revoked sessions ${dbSummary.revokedUnexpectedSessionRatePct}% > ${maxRevokedSessionRatePct}%`;
        checks.push({ status: "fail", label: "revoked_session_rate", reason });
        failures.push(reason);
      } else {
        checks.push({
          status: stats.createdWindow >= minDbSamples ? "ok" : "warn",
          label: "revoked_session_rate",
          reason: `unexpected_revoked=${stats.revokedUnexpectedWindow}/${stats.createdWindow} (${dbSummary.revokedUnexpectedSessionRatePct}%) total_revoked=${stats.revokedWindow}/${stats.createdWindow} (${dbSummary.revokedSessionRatePct}%)`,
        });
        if (stats.createdWindow < minDbSamples) {
          warnings.push(`session samples below threshold (${stats.createdWindow}/${minDbSamples})`);
        }
        if (
          stats.createdWindow >= minDbSamples &&
          dbSummary.revokedSessionRatePct > maxRevokedSessionRatePct &&
          dbSummary.revokedUnexpectedSessionRatePct <= maxRevokedSessionRatePct
        ) {
          warnings.push(
            `total revoked sessions high (${dbSummary.revokedSessionRatePct}%) but dominated by expected reasons`
          );
        }
      }
    }
  } catch (error) {
    dbSummary.enabled = true;
    dbSummary.error = String(error?.message || error);
    warnings.push(`db probe skipped: ${dbSummary.error}`);
    checks.push({
      status: "warn",
      label: "db_probe",
      reason: "db unavailable for session-rate check",
    });
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (_error) {
        // noop
      }
    }
  }

  const topAuthRoutes = Object.entries(routeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([route, count]) => ({ route, count }));

  const topAuthAppVersions = Object.entries(appVersionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([app_version, count]) => ({
      app_version,
      count,
      hard_logout_count: Number(hardLogoutByAppVersion[app_version] || 0),
    }));

  const topAuthAppBuilds = Object.entries(appBuildCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([app_build, count]) => ({ app_build, count }));

  const topAuthPlatforms = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([platform, count]) => ({ platform, count }));

  const topAuthDevices = Object.entries(deviceFpCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([device_fp, count]) => ({ device_fp, count }));

  const topStartup401Routes = Object.entries(startup401ByRoute)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([route, count]) => ({ route, count }));

  const payload = {
    ok: failures.length === 0,
    strict,
    at: new Date().toISOString(),
    window_hours: windowHours,
    scanned_lines: scannedLines,
    logs: {
      dir: logsDir,
      files: logFiles,
      auth_errors: authErrors.length,
      auth_code_counts: authCodeCounts,
      hard_logout_errors: hardLogoutErrors,
      hard_logout_error_pct: hardLogoutErrorPct,
      login_events: loginEvents.length,
      unique_login_users: uniqueLoginUsers,
      quick_relogin_users: quickReloginEmails.size,
      quick_relogin_user_rate_pct: quickReloginUserRatePct,
      top_auth_routes: topAuthRoutes,
      top_auth_app_versions: topAuthAppVersions,
      top_auth_app_builds: topAuthAppBuilds,
      top_auth_platforms: topAuthPlatforms,
      top_auth_devices: topAuthDevices,
      startup_polling_401_total: startup401Total,
      startup_polling_401_hard_logout: startup401HardLogout,
      startup_polling_401_retryable: startup401Retryable,
      startup_polling_401_hard_logout_pct: round2(
        pct(startup401HardLogout, Math.max(1, startup401Total))
      ),
      top_startup_polling_401_routes: topStartup401Routes,
    },
    db: dbSummary,
    checks,
    failures,
    warnings,
  };

  return { payload, json, strict, topAuthRoutes };
};

const main = async () => {
  const { payload, json, strict, topAuthRoutes } = await runAuthSessionMonitor();

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      `[auth-monitor] ok=${payload.ok} window=${payload.window_hours}h authErrors=${payload.logs.auth_errors} hardLogoutPct=${payload.logs.hard_logout_error_pct}% quickReloginPct=${payload.logs.quick_relogin_user_rate_pct}% revokedUnexpectedPct=${payload.db.revokedUnexpectedSessionRatePct}% revokedTotalPct=${payload.db.revokedSessionRatePct}%`
    );
    console.log(
      `[auth-monitor] startup401 total=${payload.logs.startup_polling_401_total} hardLogout=${payload.logs.startup_polling_401_hard_logout} retryable=${payload.logs.startup_polling_401_retryable} hardLogoutPct=${payload.logs.startup_polling_401_hard_logout_pct}%`
    );
    payload.checks.forEach((check) => {
      console.log(`[auth-monitor][${String(check.status).toUpperCase()}] ${check.label}: ${check.reason}`);
    });
    payload.warnings.forEach((warning) => console.log(`[auth-monitor][WARN] ${warning}`));
    if (topAuthRoutes.length) {
      console.log("[auth-monitor] top auth routes:");
      topAuthRoutes.forEach((item) => {
        console.log(` - ${item.route} => ${item.count}`);
      });
    }
    const topVersions = Array.isArray(payload?.logs?.top_auth_app_versions)
      ? payload.logs.top_auth_app_versions
      : [];
    if (topVersions.length) {
      console.log("[auth-monitor] top auth app versions:");
      topVersions.slice(0, 5).forEach((item) => {
        console.log(
          ` - ${item.app_version} => total=${item.count} hard_logout=${item.hard_logout_count}`
        );
      });
    }
    const dbRevokedReasons = Array.isArray(payload?.db?.revokedReasonCounts)
      ? payload.db.revokedReasonCounts
      : [];
    if (dbRevokedReasons.length) {
      console.log("[auth-monitor] db revoked reasons:");
      dbRevokedReasons.slice(0, 8).forEach((item) => {
        console.log(` - ${item.reason} => ${item.count}`);
      });
    }
  }

  if (strict && Array.isArray(payload.failures) && payload.failures.length) {
    process.exit(1);
  }
};

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.stack || error?.message || error);
    console.error(`[auth-monitor][FATAL] ${message}`);
    process.exit(1);
  });
}

module.exports = {
  runAuthSessionMonitor,
};
