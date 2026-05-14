#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag, fallback = "") => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  return String(argv[idx + 1] ?? fallback).trim();
};

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
  if (raw.length <= keep) return raw ? "*".repeat(raw.length) : "";
  return `${"*".repeat(Math.max(0, raw.length - keep))}${raw.slice(-keep)}`;
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

const readRecentUnitLogs = ({ unit, sinceMinutes, maxLines }) => {
  const cmd = `journalctl -u ${unit} --since "${sinceMinutes} minutes ago" --no-pager -o cat`;
  try {
    const raw = String(execSync(cmd, { encoding: "utf8" }));
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-maxLines);
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const stdout = String(error?.stdout || "").trim();
    const message = stderr || stdout || String(error?.message || error);
    return [`[journal-read-error] ${message}`];
  }
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

const sendEmail = async ({
  to,
  from,
  subject,
  html,
}) => {
  const transporter = buildMailTransport();
  if (!transporter) {
    throw new Error("email transport is not configured (EMAIL_HOST/EMAIL_USER/EMAIL_PASS)");
  }
  await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
};

const main = async () => {
  loadEnv();

  const enabled = isTruthy(
    process.env.FEED_CACHE_ALERT_ENABLED !== undefined ? process.env.FEED_CACHE_ALERT_ENABLED : "1"
  );
  if (!enabled && !hasFlag("--send-test")) {
    console.log("[feed-cache-alert] disabled by FEED_CACHE_ALERT_ENABLED");
    return;
  }

  const unit = getArgValue("--unit", process.env.FEED_CACHE_ALERT_UNIT || "minhoo-feed-cache-monitor.service");
  const sinceMinutes = toPositiveInt(
    getArgValue("--since-minutes", process.env.FEED_CACHE_ALERT_SINCE_MINUTES || "20"),
    20
  );
  const maxLines = toPositiveInt(getArgValue("--lines", process.env.FEED_CACHE_ALERT_LINES || "120"), 120);
  const sendTest = hasFlag("--send-test");
  const force = hasFlag("--force");
  const customTitle = getArgValue(
    "--title",
    String(process.env.FEED_CACHE_ALERT_TITLE || "").trim()
  ).trim();

  const cooldownSeconds = toNonNegativeInt(
    process.env.FEED_CACHE_ALERT_COOLDOWN_SECONDS || "900",
    900
  );
  const stateFile = path.resolve(
    ROOT_DIR,
    String(process.env.FEED_CACHE_ALERT_STATE_FILE || "/tmp/minhoo-feed-cache-alert-state.json")
  );

  const nowMs = Date.now();
  const state = readState(stateFile);
  const lastSentAtMs = Number(state?.last_sent_at_ms || 0);
  const elapsedMs = nowMs - (Number.isFinite(lastSentAtMs) ? lastSentAtMs : 0);
  const cooldownMs = cooldownSeconds * 1000;

  if (!sendTest && !force && cooldownMs > 0 && elapsedMs >= 0 && elapsedMs < cooldownMs) {
    console.log(
      `[feed-cache-alert] suppressed by cooldown (${Math.ceil((cooldownMs - elapsedMs) / 1000)}s left)`
    );
    return;
  }

  const logs = readRecentUnitLogs({ unit, sinceMinutes, maxLines });
  const hostname = os.hostname();
  const at = new Date().toISOString();

  const defaultTitle = sendTest
    ? "[Minhoo] TEST feed cache alert"
    : "[Minhoo] Feed cache monitor FAILED";
  const title = customTitle || defaultTitle;

  const logBlock = logs.map((line) => escapeHtml(line)).join("\n");
  const bodyHtml = [
    `<b>Time (UTC):</b> ${escapeHtml(at)}`,
    `<b>Host:</b> ${escapeHtml(hostname)}`,
    `<b>Unit:</b> ${escapeHtml(unit)}`,
    `<b>Mode:</b> ${sendTest ? "test" : "failure"}`,
    `<b>Recent logs:</b>`,
    `<pre>${logBlock || "no logs"}</pre>`,
  ].join("\n");

  const errors = [];
  let emailSent = false;
  let telegramSent = false;

  const emailEnabled = isTruthy(
    process.env.FEED_CACHE_ALERT_EMAIL_ENABLED !== undefined
      ? process.env.FEED_CACHE_ALERT_EMAIL_ENABLED
      : "1"
  );
  const emailTo = String(process.env.FEED_CACHE_ALERT_EMAIL || process.env.RISK_ALERT_EMAIL || "").trim();
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
    process.env.FEED_CACHE_ALERT_TELEGRAM_ENABLED !== undefined
      ? process.env.FEED_CACHE_ALERT_TELEGRAM_ENABLED
      : process.env.RISK_ALERT_TELEGRAM_ENABLED
  );
  const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const telegramChatId = String(
    process.env.FEED_CACHE_ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ""
  ).trim();
  const telegramThreadId = String(
    process.env.FEED_CACHE_ALERT_TELEGRAM_THREAD_ID || process.env.TELEGRAM_THREAD_ID || ""
  ).trim();
  const telegramHttpFamily = (() => {
    const parsed = Number(
      process.env.FEED_CACHE_ALERT_TELEGRAM_HTTP_FAMILY || process.env.TELEGRAM_HTTP_FAMILY || 4
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
        messageHtml: bodyHtml,
        family: telegramHttpFamily,
      });
      telegramSent = true;
    } catch (error) {
      errors.push(`telegram: ${String(error?.message || error)}`);
    }
  }

  const anySent = emailSent || telegramSent;
  if (anySent) {
    writeState(stateFile, {
      last_sent_at_ms: nowMs,
      last_sent_at_iso: at,
      last_unit: unit,
      last_mode: sendTest ? "test" : "failure",
      email_sent: emailSent,
      telegram_sent: telegramSent,
      telegram_chat_masked: maskTail(telegramChatId),
      host: hostname,
    });
    console.log(
      `[feed-cache-alert] sent email=${emailSent ? "yes" : "no"} telegram=${telegramSent ? "yes" : "no"}`
    );
    return;
  }

  const reason =
    errors.length > 0
      ? errors.join(" | ")
      : "no alert channel configured (set FEED_CACHE_ALERT_EMAIL_ENABLED/FEED_CACHE_ALERT_EMAIL and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)";
  throw new Error(`[feed-cache-alert] failed to send alert: ${reason}`);
};

main().catch((error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
