#!/usr/bin/env node
"use strict";

/**
 * health-monitor-daemon.js
 *
 * Long-running process that polls /api/v1/health every 30 s on all three
 * instances: blue (3000), green (3001), and node3 (3002). Fires alerts via
 * email + Telegram when a service goes down or enters degraded state.
 *
 * Managed by systemd (minhoo-health-monitor.service).
 *
 * Alert logic:
 *   - Alert fires after FAIL_THRESHOLD consecutive failed checks (~60 s)
 *   - Recovery alert fires when service returns to ok after being down/degraded
 *   - Cooldown prevents alert storms (repeated alerts suppressed for COOLDOWN_MS)
 *   - Degraded state (Redis/worker down but DB ok) sends a lower-priority alert
 */

/* eslint-disable no-console */
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const axios = require("axios");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const ROOT_DIR     = path.resolve(__dirname, "..");
const STATE_FILE   = "/var/www/minhoo-api/backups/minhoo-health-monitor-state.json";
const LOG_PREFIX   = "[health-monitor]";

const POLL_INTERVAL_MS  = Math.max(10_000, Number(process.env.HEALTH_MONITOR_POLL_MS   ?? 30_000) || 30_000);
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.HEALTH_MONITOR_TIMEOUT_MS ?? 8_000)  || 8_000);
const FAIL_THRESHOLD     = Math.max(1,     Number(process.env.HEALTH_MONITOR_FAIL_THRESHOLD ?? 2)  || 2);
const COOLDOWN_MS        = Math.max(60_000, Number(process.env.HEALTH_MONITOR_COOLDOWN_MS ?? 5 * 60_000) || 5 * 60_000);

const INSTANCES = [
  { label: "blue",  url: `http://127.0.0.1:3000/api/v1/health` },
  { label: "green", url: `http://127.0.0.1:3001/api/v1/health` },
  { label: "node3", url: `http://127.0.0.1:3002/api/v1/health` },
];

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const isTruthy = (v) => ["1","true","yes","on"].includes(String(v ?? "").trim().toLowerCase());

const toPositiveInt = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : fallback;
};

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

const ensureDir = (f) => {
  const d = path.dirname(f);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
};

const readState = (file) => {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch { return {}; }
};

const writeState = (file, data) => {
  ensureDir(file);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

// ------------------------------------------------------------------
// HTTP health check
// ------------------------------------------------------------------
const checkHealth = (url) =>
  new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const latencyMs = Date.now() - start;
        try {
          const json = JSON.parse(body);
          resolve({
            reachable:  true,
            statusCode: res.statusCode,
            ok:         res.statusCode === 200 && json?.ok === true,
            degraded:   Boolean(json?.degraded),
            checks:     json?.checks ?? {},
            latencyMs,
          });
        } catch {
          resolve({ reachable: true, statusCode: res.statusCode, ok: false, degraded: false, checks: {}, latencyMs });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ reachable: false, ok: false, degraded: false, checks: {}, latencyMs: null, error: "timeout" });
    });
    req.on("error", (err) => {
      resolve({ reachable: false, ok: false, degraded: false, checks: {}, latencyMs: null, error: err.message });
    });
  });

// ------------------------------------------------------------------
// Notifications
// ------------------------------------------------------------------
const buildMailTransport = () => {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = toPositiveInt(process.env.EMAIL_PORT, 587);
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: !isTruthy(process.env.EMAIL_ALLOW_INSECURE_TLS) },
  });
};

const sendEmail = async ({ to, from, subject, html }) => {
  const t = buildMailTransport();
  if (!t) throw new Error("email transport not configured");
  await t.sendMail({ from, to, subject, html });
};

const sendTelegram = async ({ token, chatId, threadId, text }) => {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (threadId) {
    const n = Number(threadId);
    if (Number.isFinite(n) && n > 0) payload.message_thread_id = n;
  }
  const family = Number(process.env.TELEGRAM_HTTP_FAMILY) === 6 ? 6 : 4;
  const res = await axios.post(url, payload, { timeout: 12_000, family, validateStatus: () => true });
  if (res.status < 200 || res.status >= 300 || res.data?.ok === false) {
    throw new Error(`telegram failed: ${res.data?.description ?? `status=${res.status}`}`);
  }
};

const notify = async ({ subject, htmlBody, textBody }) => {
  const errors = [];

  const emailTo   = String(process.env.HEALTH_MONITOR_EMAIL || process.env.RISK_ALERT_EMAIL || "").trim();
  const emailFrom = String(process.env.EMAIL_FROM || "Minhoo Alerts <noreply@minhoo.app>").trim();
  if (emailTo) {
    try {
      await sendEmail({ to: emailTo, from: emailFrom, subject, html: `<pre>${escapeHtml(htmlBody)}</pre>` });
      console.log(`${LOG_PREFIX} email sent → ${emailTo}`);
    } catch (e) { errors.push(`email: ${e.message}`); }
  }

  const tgEnabled = isTruthy(process.env.RISK_ALERT_TELEGRAM_ENABLED ?? process.env.HEALTH_MONITOR_TELEGRAM_ENABLED);
  const tgToken   = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChat    = String(process.env.HEALTH_MONITOR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "").trim();
  const tgThread  = String(process.env.HEALTH_MONITOR_TELEGRAM_THREAD_ID || process.env.TELEGRAM_THREAD_ID || "").trim();
  if (tgEnabled && tgToken && tgChat) {
    try {
      await sendTelegram({ token: tgToken, chatId: tgChat, threadId: tgThread, text: `<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(textBody)}` });
      console.log(`${LOG_PREFIX} telegram sent → chat=${tgChat}`);
    } catch (e) { errors.push(`telegram: ${e.message}`); }
  }

  if (errors.length) console.warn(`${LOG_PREFIX} notify errors: ${errors.join(" | ")}`);
};

// ------------------------------------------------------------------
// Alert builder
// ------------------------------------------------------------------
const buildAlertText = ({ mode, instance, result, consecutiveFails, at }) => {
  const emoji = mode === "down" ? "🔴" : mode === "degraded" ? "🟡" : "🟢";
  const modeLabel = mode === "down" ? "DOWN" : mode === "degraded" ? "DEGRADED" : "RECOVERED";
  const lines = [
    `${emoji} Minhoo API — ${modeLabel}`,
    `Instance : ${instance.label} (${instance.url})`,
    `Time     : ${at}`,
    `Host     : ${os.hostname()}`,
    "",
  ];

  if (mode !== "recovered") {
    lines.push(`Consecutive fails : ${consecutiveFails}`);
    lines.push(`Reachable  : ${result.reachable ? "yes" : "no"}`);
    lines.push(`HTTP status: ${result.statusCode ?? "—"}`);
    lines.push(`Latency    : ${result.latencyMs != null ? `${result.latencyMs} ms` : "—"}`);
    if (result.error) lines.push(`Error      : ${result.error}`);
    const checks = result.checks ?? {};
    if (Object.keys(checks).length) {
      lines.push("");
      lines.push("Checks:");
      for (const [k, v] of Object.entries(checks)) {
        const ok = v?.ok === true ? "✓" : "✗";
        const lat = v?.latencyMs != null ? ` (${v.latencyMs} ms)` : "";
        lines.push(`  ${ok} ${k}${lat}${v?.error ? ` — ${v.error}` : ""}`);
      }
    }
  } else {
    lines.push("Service returned to healthy state.");
    lines.push(`Latency : ${result.latencyMs != null ? `${result.latencyMs} ms` : "—"}`);
  }

  return lines.join("\n");
};

// ------------------------------------------------------------------
// Per-instance state machine
// ------------------------------------------------------------------
// state per instance: { consecutiveFails, lastAlertMode, lastAlertAtMs, lastFingerprint }

const instanceStates = {};

const getInstanceState = (label) => {
  if (!instanceStates[label]) {
    instanceStates[label] = { consecutiveFails: 0, lastAlertMode: null, lastAlertAtMs: 0, lastFingerprint: "" };
  }
  return instanceStates[label];
};

const buildFingerprint = (result) =>
  crypto.createHash("sha1")
    .update(JSON.stringify({ ok: result.ok, degraded: result.degraded, error: result.error ?? null, statusCode: result.statusCode ?? null }))
    .digest("hex");

const processInstance = async (instance, result, at) => {
  const st = getInstanceState(instance.label);
  const fingerprint = buildFingerprint(result);

  if (result.ok && !result.degraded) {
    const wasDown = st.lastAlertMode === "down" || st.lastAlertMode === "degraded";
    st.consecutiveFails = 0;

    if (wasDown) {
      // Recovery alert
      const text = buildAlertText({ mode: "recovered", instance, result, consecutiveFails: 0, at });
      const subject = `[Minhoo] API RECOVERED — ${instance.label}`;
      console.log(`${LOG_PREFIX} ${instance.label} recovered`);
      await notify({ subject, htmlBody: text, textBody: text });
      st.lastAlertMode = null;
      st.lastAlertAtMs = Date.now();
    } else {
      console.log(`${LOG_PREFIX} ${instance.label} ok latency=${result.latencyMs}ms`);
    }
    st.lastFingerprint = fingerprint;
    return;
  }

  // Failure or degraded
  if (!result.ok) {
    st.consecutiveFails += 1;
  }

  const mode = !result.ok ? "down" : "degraded";
  const reachedThreshold = mode === "down" && st.consecutiveFails >= FAIL_THRESHOLD;
  const isDegraded = mode === "degraded";
  const shouldAlert = reachedThreshold || isDegraded;

  if (!shouldAlert) {
    console.warn(`${LOG_PREFIX} ${instance.label} fail ${st.consecutiveFails}/${FAIL_THRESHOLD} — waiting threshold`);
    return;
  }

  // Cooldown check
  const nowMs = Date.now();
  const elapsedMs = nowMs - st.lastAlertAtMs;
  const fingerprintChanged = st.lastFingerprint !== fingerprint;
  const inCooldown = elapsedMs < COOLDOWN_MS && !fingerprintChanged && st.lastAlertMode === mode;

  if (inCooldown) {
    const leftSec = Math.ceil((COOLDOWN_MS - elapsedMs) / 1000);
    console.warn(`${LOG_PREFIX} ${instance.label} ${mode} — suppressed (cooldown ${leftSec}s left)`);
    st.lastFingerprint = fingerprint;
    return;
  }

  const text    = buildAlertText({ mode, instance, result, consecutiveFails: st.consecutiveFails, at });
  const subject = mode === "down"
    ? `🔴 [Minhoo] API DOWN — ${instance.label}`
    : `🟡 [Minhoo] API DEGRADED — ${instance.label}`;

  console.error(`${LOG_PREFIX} ${instance.label} ${mode} — sending alert`);
  await notify({ subject, htmlBody: text, textBody: text });

  st.lastAlertMode    = mode;
  st.lastAlertAtMs    = nowMs;
  st.lastFingerprint  = fingerprint;
};

// ------------------------------------------------------------------
// Poll loop
// ------------------------------------------------------------------
const saveGlobalState = () => {
  try {
    writeState(STATE_FILE, { updatedAt: new Date().toISOString(), instances: instanceStates });
  } catch (e) {
    console.warn(`${LOG_PREFIX} state write error: ${e.message}`);
  }
};

const restoreGlobalState = () => {
  try {
    const saved = readState(STATE_FILE);
    if (saved?.instances && typeof saved.instances === "object") {
      for (const [label, st] of Object.entries(saved.instances)) {
        instanceStates[label] = st;
      }
      console.log(`${LOG_PREFIX} restored state from ${STATE_FILE}`);
    }
  } catch { /* ignore */ }
};

const pollOnce = async () => {
  const at = new Date().toISOString();
  await Promise.all(
    INSTANCES.map(async (instance) => {
      try {
        const result = await checkHealth(instance.url);
        await processInstance(instance, result, at);
      } catch (e) {
        console.error(`${LOG_PREFIX} unhandled error for ${instance.label}: ${e.message}`);
      }
    })
  );
  saveGlobalState();
};

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------
const main = () => {
  // Load env
  dotenv.config({ path: path.resolve(ROOT_DIR, ".env") });
  try { applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: ROOT_DIR }); } catch { /* optional */ }

  restoreGlobalState();

  console.log(`${LOG_PREFIX} started — poll=${POLL_INTERVAL_MS}ms threshold=${FAIL_THRESHOLD} cooldown=${COOLDOWN_MS / 1000}s`);
  console.log(`${LOG_PREFIX} instances: ${INSTANCES.map((i) => i.url).join(", ")}`);

  // First poll immediately, then on interval
  pollOnce().catch((e) => console.error(`${LOG_PREFIX} poll error:`, e));
  setInterval(() => {
    pollOnce().catch((e) => console.error(`${LOG_PREFIX} poll error:`, e));
  }, POLL_INTERVAL_MS);
};

main();
