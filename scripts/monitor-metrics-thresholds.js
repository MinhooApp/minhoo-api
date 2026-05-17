#!/usr/bin/env node
"use strict";

/**
 * monitor-metrics-thresholds.js
 *
 * Polls /metrics (Prometheus text) and /health (JSON) on all three instances
 * every POLL_INTERVAL_MS. Fires email + Telegram alerts when:
 *
 *   - http_request_duration_ms{quantile="p95"} > THRESHOLD_P95_MS
 *   - http_request_duration_ms{quantile="p99"} > THRESHOLD_P99_MS
 *   - queue.failed > THRESHOLD_QUEUE_FAILED
 *   - db_pool.critical = true (utilization ≥ 90% or pending ≥ 5)
 *
 * Managed by systemd (minhoo-metrics-monitor.service).
 * Cooldown per alert type per instance to avoid storm.
 *
 * Env vars (optional — all have safe defaults):
 *   METRICS_MONITOR_POLL_MS          default 60000
 *   METRICS_MONITOR_COOLDOWN_MS      default 600000  (10 min)
 *   METRICS_MONITOR_TIMEOUT_MS       default 5000
 *   THRESHOLD_P95_MS                 default 500
 *   THRESHOLD_P99_MS                 default 2000
 *   THRESHOLD_QUEUE_FAILED           default 10
 *   HEALTH_MONITOR_EMAIL             alert recipient
 *   TELEGRAM_BOT_TOKEN / HEALTH_MONITOR_TELEGRAM_CHAT_ID
 */

/* eslint-disable no-console */
const http       = require("http");
const fs         = require("fs");
const path       = require("path");
const os         = require("os");
const nodemailer = require("nodemailer");
const axios      = require("axios");
const dotenv     = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const ROOT_DIR   = path.resolve(__dirname, "..");
const LOG_PREFIX = "[metrics-monitor]";

const POLL_MS     = Math.max(10_000, Number(process.env.METRICS_MONITOR_POLL_MS    ?? 60_000)  || 60_000);
const COOLDOWN_MS = Math.max(60_000, Number(process.env.METRICS_MONITOR_COOLDOWN_MS ?? 600_000) || 600_000);
const TIMEOUT_MS  = Math.max(2_000,  Number(process.env.METRICS_MONITOR_TIMEOUT_MS  ?? 5_000)   || 5_000);

const THRESHOLD_P95_MS      = Math.max(0, Number(process.env.THRESHOLD_P95_MS      ?? 500)  || 500);
const THRESHOLD_P99_MS      = Math.max(0, Number(process.env.THRESHOLD_P99_MS      ?? 2000) || 2000);
const THRESHOLD_QUEUE_FAILED = Math.max(0, Number(process.env.THRESHOLD_QUEUE_FAILED ?? 10)  || 10);

const INSTANCES = [
  { label: "blue",  base: "http://127.0.0.1:3000/api/v1" },
  { label: "green", base: "http://127.0.0.1:3001/api/v1" },
  { label: "node3", base: "http://127.0.0.1:3002/api/v1" },
];

// ------------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------------
const isTruthy = (v) => ["1","true","yes","on"].includes(String(v ?? "").trim().toLowerCase());

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
    req.on("error", reject);
  });

// ------------------------------------------------------------------
// Parsers
// ------------------------------------------------------------------

/** Extract a single gauge value from Prometheus text exposition */
const parsePromGauge = (text, metricName, labelFilter = {}) => {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith(metricName)) continue;
    if (line.startsWith("# ")) continue;
    const match = labelFilter && Object.keys(labelFilter).length > 0;
    if (match) {
      const allMatch = Object.entries(labelFilter).every(([k, v]) =>
        line.includes(`${k}="${v}"`)
      );
      if (!allMatch) continue;
    }
    const parts = line.trimEnd().split(" ");
    const val = parseFloat(parts[parts.length - 1]);
    if (Number.isFinite(val)) return val;
  }
  return null;
};

const parseHealth = (body) => {
  try { return JSON.parse(body); } catch { return null; }
};

// ------------------------------------------------------------------
// Notify (same pattern as health-monitor-daemon)
// ------------------------------------------------------------------
const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

const buildMailTransport = () => {
  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = Math.max(1, Number(process.env.EMAIL_PORT) || 587);
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

const notify = async ({ subject, body }) => {
  const errors = [];
  const emailTo   = String(process.env.HEALTH_MONITOR_EMAIL || process.env.RISK_ALERT_EMAIL || "").trim();
  const emailFrom = String(process.env.EMAIL_FROM || "Minhoo Alerts <noreply@minhoo.app>").trim();
  if (emailTo) {
    try {
      await sendEmail({ to: emailTo, from: emailFrom, subject, html: `<pre>${escapeHtml(body)}</pre>` });
      console.log(`${LOG_PREFIX} email sent → ${emailTo}`);
    } catch (e) { errors.push(`email: ${e.message}`); }
  }
  const tgEnabled = isTruthy(process.env.RISK_ALERT_TELEGRAM_ENABLED ?? process.env.HEALTH_MONITOR_TELEGRAM_ENABLED);
  const tgToken   = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tgChat    = String(process.env.HEALTH_MONITOR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "").trim();
  const tgThread  = String(process.env.HEALTH_MONITOR_TELEGRAM_THREAD_ID || process.env.TELEGRAM_THREAD_ID || "").trim();
  if (tgEnabled && tgToken && tgChat) {
    try {
      await sendTelegram({ token: tgToken, chatId: tgChat, threadId: tgThread, text: `<b>${escapeHtml(subject)}</b>\n\n${escapeHtml(body)}` });
      console.log(`${LOG_PREFIX} telegram sent → chat=${tgChat}`);
    } catch (e) { errors.push(`telegram: ${e.message}`); }
  }
  if (!emailTo && !(tgEnabled && tgToken && tgChat)) {
    console.warn(`${LOG_PREFIX} ALERT (no channel configured): ${subject}`);
  }
  if (errors.length) console.warn(`${LOG_PREFIX} notify errors: ${errors.join(" | ")}`);
};

// ------------------------------------------------------------------
// Cooldown state (in-memory)
// ------------------------------------------------------------------
// key: `${instanceLabel}:${alertType}`
const cooldowns = new Map();

const shouldFire = (key) => {
  const last = cooldowns.get(key) ?? 0;
  return Date.now() - last >= COOLDOWN_MS;
};

const markFired = (key) => cooldowns.set(key, Date.now());

// ------------------------------------------------------------------
// Alert builders
// ------------------------------------------------------------------
const buildLatencyAlert = ({ instance, quantile, valueMs, thresholdMs }) => ({
  subject: `🔴 [Minhoo] HIGH LATENCY — ${instance.label} p${quantile}=${valueMs}ms`,
  body: [
    `🔴 Minhoo API — HIGH LATENCY`,
    `Instance  : ${instance.label} (${instance.base})`,
    `Time      : ${new Date().toISOString()}`,
    `Host      : ${os.hostname()}`,
    ``,
    `Metric    : http_request_duration_ms{quantile="p${quantile}"}`,
    `Value     : ${valueMs} ms`,
    `Threshold : ${thresholdMs} ms`,
  ].join("\n"),
});

const buildQueueFailedAlert = ({ instance, failed, threshold }) => ({
  subject: `🔴 [Minhoo] QUEUE FAILED JOBS — ${instance.label} failed=${failed}`,
  body: [
    `🔴 Minhoo API — QUEUE FAILED JOBS`,
    `Instance  : ${instance.label} (${instance.base})`,
    `Time      : ${new Date().toISOString()}`,
    `Host      : ${os.hostname()}`,
    ``,
    `Queue     : push-notifications`,
    `Failed    : ${failed} jobs`,
    `Threshold : ${threshold} jobs`,
    ``,
    `Action    : Check BullMQ dashboard or run: curl -s http://127.0.0.1:3000/api/v1/ready | python3 -m json.tool`,
  ].join("\n"),
});

const buildPoolCriticalAlert = ({ instance, pool }) => ({
  subject: `🔴 [Minhoo] DB POOL CRITICAL — ${instance.label} active=${pool.active}/${pool.maxPool} pending=${pool.pending}`,
  body: [
    `🔴 Minhoo API — DB POOL CRITICAL`,
    `Instance  : ${instance.label} (${instance.base})`,
    `Time      : ${new Date().toISOString()}`,
    `Host      : ${os.hostname()}`,
    ``,
    `Pool      : active=${pool.active} pending=${pool.pending} total=${pool.total ?? "?"} maxPool=${pool.maxPool}`,
    `Saturation: ${Math.round((pool.active / pool.maxPool) * 100)}%`,
    ``,
    `Action    : Check slow queries: sudo mysql -e "SHOW PROCESSLIST"`,
  ].join("\n"),
});

// ------------------------------------------------------------------
// Per-instance check
// ------------------------------------------------------------------
const checkInstance = async (instance) => {
  let metricsText = null;
  let healthJson  = null;

  try {
    const r = await httpGet(`${instance.base}/metrics`);
    if (r.status === 200) metricsText = r.body;
  } catch (e) {
    console.warn(`${LOG_PREFIX} ${instance.label} /metrics unreachable: ${e.message}`);
  }

  try {
    const r = await httpGet(`${instance.base}/health`);
    if (r.status >= 200 && r.status < 600) healthJson = parseHealth(r.body);
  } catch (e) {
    console.warn(`${LOG_PREFIX} ${instance.label} /health unreachable: ${e.message}`);
  }

  const alerts = [];

  // ── p95 latency ──────────────────────────────────────────────────
  if (metricsText) {
    const p95 = parsePromGauge(metricsText, "http_request_duration_ms", { quantile: "p95" });
    if (p95 !== null) {
      console.log(`${LOG_PREFIX} ${instance.label} p95=${p95}ms threshold=${THRESHOLD_P95_MS}ms`);
      if (p95 > THRESHOLD_P95_MS) {
        const key = `${instance.label}:p95`;
        if (shouldFire(key)) {
          alerts.push(buildLatencyAlert({ instance, quantile: 95, valueMs: Math.round(p95), thresholdMs: THRESHOLD_P95_MS }));
          markFired(key);
        }
      }
    }

    // ── p99 latency ─────────────────────────────────────────────────
    const p99 = parsePromGauge(metricsText, "http_request_duration_ms", { quantile: "p99" });
    if (p99 !== null) {
      console.log(`${LOG_PREFIX} ${instance.label} p99=${p99}ms threshold=${THRESHOLD_P99_MS}ms`);
      if (p99 > THRESHOLD_P99_MS) {
        const key = `${instance.label}:p99`;
        if (shouldFire(key)) {
          alerts.push(buildLatencyAlert({ instance, quantile: 99, valueMs: Math.round(p99), thresholdMs: THRESHOLD_P99_MS }));
          markFired(key);
        }
      }
    }
  }

  // ── Queue failed ─────────────────────────────────────────────────
  if (healthJson?.checks?.queue) {
    const { failed } = healthJson.checks.queue;
    console.log(`${LOG_PREFIX} ${instance.label} queue.failed=${failed} threshold=${THRESHOLD_QUEUE_FAILED}`);
    if (failed > THRESHOLD_QUEUE_FAILED) {
      const key = `${instance.label}:queue_failed`;
      if (shouldFire(key)) {
        alerts.push(buildQueueFailedAlert({ instance, failed, threshold: THRESHOLD_QUEUE_FAILED }));
        markFired(key);
      }
    }
  }

  // ── DB pool critical ─────────────────────────────────────────────
  if (healthJson?.checks?.db_pool?.critical) {
    const pool = healthJson.checks.db_pool;
    console.log(`${LOG_PREFIX} ${instance.label} db_pool.critical=true active=${pool.active} pending=${pool.pending}`);
    const key = `${instance.label}:pool_critical`;
    if (shouldFire(key)) {
      alerts.push(buildPoolCriticalAlert({ instance, pool }));
      markFired(key);
    }
  }

  for (const alert of alerts) {
    console.error(`${LOG_PREFIX} firing alert: ${alert.subject}`);
    try {
      await notify(alert);
    } catch (e) {
      console.error(`${LOG_PREFIX} notify failed: ${e.message}`);
    }
  }
};

// ------------------------------------------------------------------
// Poll loop
// ------------------------------------------------------------------
const pollOnce = async () => {
  await Promise.all(
    INSTANCES.map((instance) =>
      checkInstance(instance).catch((e) =>
        console.error(`${LOG_PREFIX} unhandled error for ${instance.label}: ${e.message}`)
      )
    )
  );
};

const main = () => {
  dotenv.config({ path: path.resolve(ROOT_DIR, ".env") });
  try { applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: ROOT_DIR }); } catch { /* optional */ }

  console.log(`${LOG_PREFIX} started — poll=${POLL_MS}ms cooldown=${COOLDOWN_MS / 1000}s`);
  console.log(`${LOG_PREFIX} thresholds: p95=${THRESHOLD_P95_MS}ms p99=${THRESHOLD_P99_MS}ms queue_failed=${THRESHOLD_QUEUE_FAILED}`);
  console.log(`${LOG_PREFIX} instances: ${INSTANCES.map((i) => i.base).join(", ")}`);

  pollOnce().catch((e) => console.error(`${LOG_PREFIX} poll error:`, e));
  setInterval(() => {
    pollOnce().catch((e) => console.error(`${LOG_PREFIX} poll error:`, e));
  }, POLL_MS);
};

main();
