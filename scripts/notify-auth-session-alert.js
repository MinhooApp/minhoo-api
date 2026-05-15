#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");
const { runAuthSessionMonitor } = require("./monitor-auth-session-health");

const ROOT_DIR = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag, fallback = "") => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  return String(argv[idx + 1] ?? fallback).trim();
};

const toPositiveInt = (value, fallback, min = 1) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.trunc(n);
};

const toNonNegativeInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const maskTail = (value, keep = 6) => {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= keep) return "*".repeat(raw.length);
  return `${"*".repeat(Math.max(0, raw.length - keep))}${raw.slice(-keep)}`;
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const readState = (stateFile) => {
  try {
    if (!fs.existsSync(stateFile)) return {};
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeState = (stateFile, nextState) => {
  ensureDir(stateFile);
  fs.writeFileSync(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
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

const buildMailTransport = () => {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = toPositiveInt(process.env.EMAIL_PORT, 587);
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: {
      rejectUnauthorized: !isTruthy(process.env.EMAIL_ALLOW_INSECURE_TLS),
    },
  });
};

const sendEmail = async ({ to, from, subject, html }) => {
  const transporter = buildMailTransport();
  if (!transporter) {
    throw new Error("email transport not configured (EMAIL_HOST/EMAIL_USER/EMAIL_PASS)");
  }
  await transporter.sendMail({ from, to, subject, html });
};

const sendTelegram = async ({
  token,
  chatId,
  threadId,
  title,
  messageHtml,
  family,
}) => {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: `<b>${escapeHtml(title)}</b>\n${messageHtml}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (threadId) {
    const parsed = Number(threadId);
    if (Number.isFinite(parsed) && parsed > 0) payload.message_thread_id = parsed;
  }

  const response = await axios.post(url, payload, {
    timeout: 12000,
    family,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300 || response.data?.ok === false) {
    const details = response.data?.description || `status=${response.status}`;
    throw new Error(`telegram send failed (${details})`);
  }
};

const runMonitor = async () => {
  const overrideWindow = getArgValue("--window-hours", "");
  if (overrideWindow) {
    process.env.AUTH_MONITOR_WINDOW_HOURS = overrideWindow;
  }
  const result = await runAuthSessionMonitor({
    strictOverride: false,
    jsonOverride: true,
    skipLoadEnv: true,
  });
  return result?.payload || {};
};

const formatTopAuthAppVersions = (items, limit = 5) => {
  const rows = Array.isArray(items) ? items.slice(0, limit) : [];
  return rows.map((item) => {
    const version = String(item?.app_version || "unknown");
    const total = Number(item?.count || 0);
    const hard = Number(item?.hard_logout_count || 0);
    return `${version}: ${hard}/${total} hard-logout`;
  });
};

const formatRevokedReasons = (items, limit = 6) => {
  const rows = Array.isArray(items) ? items.slice(0, limit) : [];
  return rows.map((item) => {
    const reason = String(item?.reason || "unknown").trim() || "unknown";
    const count = Number(item?.count || 0);
    return `${reason}: ${count}`;
  });
};

const isRevokedRateFailure = (report) => {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const revokedCheck = checks.find(
    (item) => String(item?.label || "").trim() === "revoked_session_rate"
  );
  if (revokedCheck && String(revokedCheck.status || "").trim().toLowerCase() === "fail") return true;
  return failures.some((item) => String(item || "").toLowerCase().includes("revoked sessions"));
};

const isCheckFailure = (report, label) => {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const check = checks.find((item) => String(item?.label || "").trim() === String(label || "").trim());
  return Boolean(check && String(check.status || "").trim().toLowerCase() === "fail");
};

const isHardLogoutFailure = (report) => isCheckFailure(report, "auth_hard_logout_rate");
const isQuickReloginFailure = (report) => isCheckFailure(report, "quick_relogin_rate");

const buildFingerprint = (report) => {
  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const db = report?.db || {};
  const parts = {
    failures,
    revokedSessionRatePct: Number(db?.revokedSessionRatePct || 0),
    revokedUnexpectedSessionRatePct: Number(db?.revokedUnexpectedSessionRatePct || 0),
    createdWindow: Number(db?.createdWindow || 0),
    revokedWindow: Number(db?.revokedWindow || 0),
    revokedUnexpectedWindow: Number(db?.revokedUnexpectedWindow || 0),
    quickReloginUserRatePct: Number(report?.logs?.quick_relogin_user_rate_pct || 0),
    hardLogoutErrorPct: Number(report?.logs?.hard_logout_error_pct || 0),
  };
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};

const main = async () => {
  loadEnv();

  const enabled = isTruthy(
    process.env.AUTH_SESSION_ALERT_ENABLED !== undefined
      ? process.env.AUTH_SESSION_ALERT_ENABLED
      : "1"
  );
  const sendTest = hasFlag("--send-test");
  const dryRun = hasFlag("--dry-run");
  const force = hasFlag("--force");
  const notifyRecovery = isTruthy(process.env.AUTH_SESSION_ALERT_NOTIFY_RECOVERY ?? "0");
  const onlyRevokedRate = isTruthy(process.env.AUTH_SESSION_ALERT_ONLY_REVOKED_RATE ?? "1");
  const requireImpactSignals = isTruthy(
    process.env.AUTH_SESSION_ALERT_REQUIRE_IMPACT_SIGNALS ?? "1"
  );
  const revokedCriticalPct = toPositiveInt(
    process.env.AUTH_SESSION_ALERT_REVOKED_CRITICAL_PCT,
    85
  );
  const revokedCriticalMinCreated = toPositiveInt(
    process.env.AUTH_SESSION_ALERT_REVOKED_CRITICAL_MIN_CREATED,
    80
  );

  if (!enabled && !sendTest) {
    console.log("[auth-session-alert] disabled by AUTH_SESSION_ALERT_ENABLED");
    return;
  }

  const cooldownSeconds = toNonNegativeInt(
    process.env.AUTH_SESSION_ALERT_COOLDOWN_SECONDS || "900",
    900
  );
  const stateFile = path.resolve(
    ROOT_DIR,
    String(
      process.env.AUTH_SESSION_ALERT_STATE_FILE ||
        "/var/www/minhoo-api/backups/minhoo-auth-session-alert-state.json"
    )
  );

  const report = await runMonitor();
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const hostname = os.hostname();

  const failures = Array.isArray(report?.failures) ? report.failures : [];
  const hasAnyFailure = failures.length > 0;
  const revokedRateFailure = isRevokedRateFailure(report);
  const hardLogoutFailure = isHardLogoutFailure(report);
  const quickReloginFailure = isQuickReloginFailure(report);
  const impactFailure = hardLogoutFailure || quickReloginFailure;
  const revokedRatePct = Number(report?.db?.revokedUnexpectedSessionRatePct || 0);
  const revokedCreatedWindow = Number(report?.db?.createdWindow || 0);
  const revokedCritical =
    revokedRateFailure &&
    Number.isFinite(revokedRatePct) &&
    Number.isFinite(revokedCreatedWindow) &&
    revokedRatePct >= revokedCriticalPct &&
    revokedCreatedWindow >= revokedCriticalMinCreated;
  const baseMustAlert = hasAnyFailure && (!onlyRevokedRate || revokedRateFailure);
  const mustAlert = sendTest || (baseMustAlert && (!requireImpactSignals || impactFailure || revokedCritical));

  const state = readState(stateFile);
  const activePrev = Boolean(state?.active);
  const lastSentAtMs = Number(state?.last_sent_at_ms || 0);
  const elapsedMs = nowMs - (Number.isFinite(lastSentAtMs) ? lastSentAtMs : 0);
  const cooldownMs = cooldownSeconds * 1000;
  const fingerprint = buildFingerprint(report);
  const fingerprintChanged = String(state?.last_fingerprint || "") !== fingerprint;

  let mode = "ok";
  if (sendTest) mode = "test";
  else if (mustAlert) mode = "risk";
  else if (activePrev && notifyRecovery) mode = "recovery";

  if (mode === "ok") {
    writeState(stateFile, {
      ...state,
      active: false,
      last_ok_at_ms: nowMs,
      last_ok_at_iso: at,
      host: hostname,
    });
    if (hasAnyFailure && requireImpactSignals && !impactFailure && !revokedCritical) {
      console.log(
        "[auth-session-alert] risk muted (no user-impact signals: hard_logout/quick_relogin)"
      );
    } else {
      console.log("[auth-session-alert] healthy, no alert sent");
    }
    return;
  }

  const blockedByCooldown =
    !sendTest &&
    !force &&
    mode === "risk" &&
    cooldownMs > 0 &&
    elapsedMs >= 0 &&
    elapsedMs < cooldownMs &&
    !fingerprintChanged;

  if (blockedByCooldown) {
    const leftSec = Math.ceil((cooldownMs - elapsedMs) / 1000);
    console.log(`[auth-session-alert] suppressed by cooldown (${leftSec}s left)`);
    return;
  }

  const title =
    mode === "test"
      ? "[Minhoo] TEST auth session alert"
      : mode === "recovery"
        ? "[Minhoo] Auth session risk RECOVERED"
        : "[Minhoo] Auth session risk detected";

  const db = report?.db || {};
  const logs = report?.logs || {};
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const topAuthAppVersions = formatTopAuthAppVersions(logs?.top_auth_app_versions, 5);
  const topRevokedReasons = formatRevokedReasons(db?.revokedReasonCounts, 6);
  const ignoredRevokedReasons = Array.isArray(db?.revokedIgnoredReasons)
    ? db.revokedIgnoredReasons.slice(0, 10).map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const formattedFailures = failures.length
    ? failures.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>none</li>";
  const formattedChecks = checks.length
    ? checks
        .map(
          (item) =>
            `<li>[${escapeHtml(String(item?.status || "").toUpperCase())}] ${escapeHtml(
              item?.label
            )}: ${escapeHtml(item?.reason)}</li>`
        )
        .join("")
    : "<li>none</li>";
  const failuresTextLines = failures.length ? failures.map((item) => `- ${String(item)}`) : ["- none"];
  const checksTextLines = checks.length
    ? checks.map(
        (item) =>
          `- [${String(item?.status || "").toUpperCase()}] ${String(item?.label || "")}: ${String(item?.reason || "")}`
      )
    : ["- none"];

  const bodyHtml = [
    `<b>Time (UTC):</b> ${escapeHtml(at)}`,
    `<b>Host:</b> ${escapeHtml(hostname)}`,
    `<b>Mode:</b> ${escapeHtml(mode)}`,
    `<b>Window (hours):</b> ${escapeHtml(report?.window_hours)}`,
    `<b>Unexpected revoked session rate:</b> ${escapeHtml(
      db?.revokedUnexpectedSessionRatePct
    )}% (${escapeHtml(db?.revokedUnexpectedWindow)}/${escapeHtml(db?.createdWindow)})`,
    `<b>Total revoked session rate:</b> ${escapeHtml(db?.revokedSessionRatePct)}% (${escapeHtml(
      db?.revokedWindow
    )}/${escapeHtml(db?.createdWindow)})`,
    `<b>Hard logout auth errors:</b> ${escapeHtml(logs?.hard_logout_error_pct)}% (${escapeHtml(
      logs?.hard_logout_errors
    )}/${escapeHtml(logs?.auth_errors)})`,
    `<b>Quick relogin users:</b> ${escapeHtml(logs?.quick_relogin_user_rate_pct)}% (${escapeHtml(
      logs?.quick_relogin_users
    )}/${escapeHtml(logs?.unique_login_users)})`,
    `<b>Startup polling 401:</b> total=${escapeHtml(
      logs?.startup_polling_401_total
    )} hard_logout=${escapeHtml(logs?.startup_polling_401_hard_logout)} retryable=${escapeHtml(
      logs?.startup_polling_401_retryable
    )} hard_logout_pct=${escapeHtml(logs?.startup_polling_401_hard_logout_pct)}%`,
    topRevokedReasons.length
      ? `<b>Top revoked reasons:</b> ${escapeHtml(topRevokedReasons.join(" | "))}`
      : "",
    ignoredRevokedReasons.length
      ? `<b>Ignored revoked reasons:</b> ${escapeHtml(ignoredRevokedReasons.join(", "))}`
      : "",
    topAuthAppVersions.length
      ? `<b>Top app versions (hard/total):</b> ${escapeHtml(topAuthAppVersions.join(" | "))}`
      : "",
    `<b>Failures:</b><ul>${formattedFailures}</ul>`,
    `<b>Checks:</b><ul>${formattedChecks}</ul>`,
  ]
    .filter(Boolean)
    .join("\n");
  const telegramBody = [
    `Time (UTC): ${at}`,
    `Host: ${hostname}`,
    `Mode: ${mode}`,
    `Window (hours): ${report?.window_hours}`,
    `Unexpected revoked session rate: ${db?.revokedUnexpectedSessionRatePct}% (${db?.revokedUnexpectedWindow}/${db?.createdWindow})`,
    `Total revoked session rate: ${db?.revokedSessionRatePct}% (${db?.revokedWindow}/${db?.createdWindow})`,
    `Hard logout auth errors: ${logs?.hard_logout_error_pct}% (${logs?.hard_logout_errors}/${logs?.auth_errors})`,
    `Quick relogin users: ${logs?.quick_relogin_user_rate_pct}% (${logs?.quick_relogin_users}/${logs?.unique_login_users})`,
    `Startup polling 401: total=${logs?.startup_polling_401_total} hard_logout=${logs?.startup_polling_401_hard_logout} retryable=${logs?.startup_polling_401_retryable} hard_logout_pct=${logs?.startup_polling_401_hard_logout_pct}%`,
    ...(topRevokedReasons.length ? [`Top revoked reasons: ${topRevokedReasons.join(" | ")}`] : []),
    ...(ignoredRevokedReasons.length
      ? [`Ignored revoked reasons: ${ignoredRevokedReasons.join(", ")}`]
      : []),
    ...(topAuthAppVersions.length
      ? [`Top app versions (hard/total): ${topAuthAppVersions.join(" | ")}`]
      : []),
    `Impact signals: hardLogoutFail=${hardLogoutFailure ? "yes" : "no"}, quickReloginFail=${
      quickReloginFailure ? "yes" : "no"
    }, revokedCritical=${revokedCritical ? "yes" : "no"}`,
    "Failures:",
    ...failuresTextLines,
    "Checks:",
    ...checksTextLines,
  ]
    .map((line) => escapeHtml(line))
    .join("\n");

  if (dryRun) {
    console.log(`[auth-session-alert] dry-run mode=${mode} title="${title}"`);
    console.log(bodyHtml);
    return;
  }

  const errors = [];
  let emailSent = false;
  let telegramSent = false;

  const emailEnabled = isTruthy(
    process.env.AUTH_SESSION_ALERT_EMAIL_ENABLED !== undefined
      ? process.env.AUTH_SESSION_ALERT_EMAIL_ENABLED
      : "1"
  );
  const emailTo = String(process.env.AUTH_SESSION_ALERT_EMAIL || process.env.RISK_ALERT_EMAIL || "").trim();
  const emailFrom = String(process.env.EMAIL_FROM || "Minhoo Alerts <noreply@minhoo.app>").trim();
  if (emailEnabled && emailTo) {
    try {
      await sendEmail({
        to: emailTo,
        from: emailFrom,
        subject: `${title} @ ${hostname}`,
        html: `<p>${bodyHtml}</p>`,
      });
      emailSent = true;
    } catch (error) {
      errors.push(`email: ${String(error?.message || error)}`);
    }
  }

  const telegramEnabled = isTruthy(
    process.env.AUTH_SESSION_ALERT_TELEGRAM_ENABLED !== undefined
      ? process.env.AUTH_SESSION_ALERT_TELEGRAM_ENABLED
      : process.env.RISK_ALERT_TELEGRAM_ENABLED
  );
  const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const telegramChatId = String(
    process.env.AUTH_SESSION_ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ""
  ).trim();
  const telegramThreadId = String(
    process.env.AUTH_SESSION_ALERT_TELEGRAM_THREAD_ID || process.env.TELEGRAM_THREAD_ID || ""
  ).trim();
  const telegramHttpFamily = (() => {
    const parsed = Number(
      process.env.AUTH_SESSION_ALERT_TELEGRAM_HTTP_FAMILY || process.env.TELEGRAM_HTTP_FAMILY || 4
    );
    return Number.isFinite(parsed) && (parsed === 4 || parsed === 6) ? parsed : 4;
  })();

  if (telegramEnabled && telegramToken && telegramChatId) {
    try {
      await sendTelegram({
        token: telegramToken,
        chatId: telegramChatId,
        threadId: telegramThreadId,
        title,
        messageHtml: telegramBody,
        family: telegramHttpFamily,
      });
      telegramSent = true;
    } catch (error) {
      errors.push(`telegram: ${String(error?.message || error)}`);
    }
  }

  if (!emailSent && !telegramSent) {
    const reason =
      errors.length > 0
        ? errors.join(" | ")
        : "no alert channel configured (AUTH_SESSION_ALERT_EMAIL or TELEGRAM_BOT_TOKEN+CHAT_ID)";
    throw new Error(`[auth-session-alert] alert send failed: ${reason}`);
  }

  writeState(stateFile, {
    active: mode === "risk",
    last_mode: mode,
    last_sent_at_ms: nowMs,
    last_sent_at_iso: at,
    last_fingerprint: fingerprint,
    email_sent: emailSent,
    telegram_sent: telegramSent,
    telegram_chat_masked: maskTail(telegramChatId),
    host: hostname,
    report_snapshot: {
      failures,
      revokedUnexpectedSessionRatePct: Number(db?.revokedUnexpectedSessionRatePct || 0),
      revokedUnexpectedWindow: Number(db?.revokedUnexpectedWindow || 0),
      revokedSessionRatePct: Number(db?.revokedSessionRatePct || 0),
      createdWindow: Number(db?.createdWindow || 0),
      revokedWindow: Number(db?.revokedWindow || 0),
      hardLogoutErrorPct: Number(logs?.hard_logout_error_pct || 0),
      quickReloginUserRatePct: Number(logs?.quick_relogin_user_rate_pct || 0),
      hardLogoutFailure,
      quickReloginFailure,
      revokedCritical,
    },
  });

  console.log(
    `[auth-session-alert] sent mode=${mode} email=${emailSent ? "yes" : "no"} telegram=${telegramSent ? "yes" : "no"}`
  );
};

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
