#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);

const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag, fallback = "") => {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  return String(argv[index + 1] ?? fallback).trim();
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

const toFiniteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

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

const toEpochMs = (value) => {
  const parsedNumber = Number(value);
  if (Number.isFinite(parsedNumber) && parsedNumber > 0) return parsedNumber;
  const parsedDate = Date.parse(String(value || ""));
  if (Number.isFinite(parsedDate) && parsedDate > 0) return parsedDate;
  return 0;
};

const parseSamplesFile = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const samples = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const payload = parsed?.payload;
      if (!payload || typeof payload !== "object") continue;
      const sampledAtMs = toEpochMs(parsed?.sampled_at || payload?.at);
      samples.push({
        sampled_at: parsed?.sampled_at || payload?.at || null,
        sampled_at_ms: sampledAtMs,
        monitor_exit_code: toFiniteNumber(parsed?.monitor_exit_code, 1),
        payload,
      });
    } catch {
      // ignore malformed lines
    }
  }
  return samples;
};

const stat = (values) => {
  const data = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!data.length) return null;
  data.sort((a, b) => a - b);
  const total = data.reduce((acc, value) => acc + value, 0);
  const idx = (ratio) =>
    Math.max(0, Math.min(data.length - 1, Math.floor((data.length - 1) * ratio)));
  return {
    min: round2(data[0]),
    max: round2(data[data.length - 1]),
    avg: round2(total / data.length),
    p50: round2(data[idx(0.5)]),
    p95: round2(data[idx(0.95)]),
  };
};

const findCheck = (payload, id) =>
  (Array.isArray(payload?.checks) ? payload.checks : []).find((check) => check?.id === id) || null;

const summarize = (samples) => {
  const total = samples.length;
  const strictOk = samples.filter((sample) => sample?.payload?.ok === true).length;
  const strictFail = total - strictOk;

  const globalP95 = stat(samples.map((sample) => sample?.payload?.global?.p95_ms));
  const globalP99 = stat(samples.map((sample) => sample?.payload?.global?.p99_ms));
  const postP95 = stat(samples.map((sample) => findCheck(sample?.payload, "post_summary")?.p95_ms));
  const reelP95 = stat(samples.map((sample) => findCheck(sample?.payload, "reel_summary")?.p95_ms));
  const bootstrapP95 = stat(
    samples.map((sample) => findCheck(sample?.payload, "bootstrap_home_full")?.p95_ms)
  );
  const errRate = stat(samples.map((sample) => sample?.payload?.global?.error_rate_percent));
  const throttled429Rate = stat(
    samples.map((sample) => sample?.payload?.global?.throttled_429_rate_percent)
  );

  const postNonOk = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "post_summary");
    return check && check.status !== "ok";
  }).length;

  const reelNonOk = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "reel_summary");
    return check && check.status !== "ok";
  }).length;

  const bootstrapNonOk = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "bootstrap_home_full");
    return check && check.status !== "ok";
  }).length;

  const postFail = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "post_summary");
    return check && check.status === "fail";
  }).length;

  const reelFail = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "reel_summary");
    return check && check.status === "fail";
  }).length;

  const bootstrapFail = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "bootstrap_home_full");
    return check && check.status === "fail";
  }).length;

  const postWarn = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "post_summary");
    return check && check.status === "warning";
  }).length;

  const reelWarn = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "reel_summary");
    return check && check.status === "warning";
  }).length;

  const bootstrapWarn = samples.filter((sample) => {
    const check = findCheck(sample?.payload, "bootstrap_home_full");
    return check && check.status === "warning";
  }).length;

  const strictPassRate = total > 0 ? round2((strictOk * 100) / total) : 0;

  return {
    total,
    strictOk,
    strictFail,
    strictPassRate,
    globalP95,
    globalP99,
    postP95,
    reelP95,
    bootstrapP95,
    errRate,
    throttled429Rate,
    postNonOk,
    reelNonOk,
    bootstrapNonOk,
    postFail,
    reelFail,
    bootstrapFail,
    postWarn,
    reelWarn,
    bootstrapWarn,
    firstAt: samples[0]?.sampled_at || null,
    lastAt: samples[samples.length - 1]?.sampled_at || null,
  };
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
  const transport = buildMailTransport();
  if (!transport) throw new Error("email transport is not configured");
  await transport.sendMail({ to, from, subject, html });
};

const sendTelegram = async ({ token, chatId, threadId, title, bodyHtml, family }) => {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: `<b>${escapeHtml(title)}</b>\n${bodyHtml}`,
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

const formatStat = (value) => {
  if (!value) return "na";
  return `avg=${value.avg} p50=${value.p50} p95=${value.p95} min=${value.min} max=${value.max}`;
};

const main = async () => {
  loadEnv();

  const noSend = hasFlag("--no-send");
  const sendTest = hasFlag("--send-test");
  const lookbackHours = toPositiveInt(
    getArgValue("--hours", process.env.FEED_SLO_REPORT_LOOKBACK_HOURS || "24"),
    24
  );
  const strictFailBudget = toNonNegativeInt(
    getArgValue(
      "--strict-fail-budget",
      process.env.FEED_SLO_REPORT_STRICT_FAIL_BUDGET || "1"
    ),
    1
  );
  const samplesFile = path.resolve(
    ROOT_DIR,
    String(process.env.FEED_SLO_24H_SAMPLES_FILE || "/tmp/minhoo-feed-slo-samples.jsonl")
  );

  const allSamples = parseSamplesFile(samplesFile);
  const cutoffMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const samples = allSamples.filter((sample) => (sample.sampled_at_ms || 0) >= cutoffMs);
  const summary = summarize(samples);
  const hostname = os.hostname();
  const reportAt = new Date().toISOString();

  const overallOk =
    summary.total > 0 &&
    summary.strictFail <= strictFailBudget &&
    summary.postFail === 0 &&
    summary.reelFail === 0 &&
    summary.bootstrapFail === 0;
  const statusText = overallOk ? "PASS" : "WARN";
  const title = `[Minhoo] Feed SLO ${lookbackHours}h report ${statusText}`;

  const lines = [
    `host=${hostname}`,
    `report_at=${reportAt}`,
    `window_hours=${lookbackHours}`,
    `samples=${summary.total}`,
    `strict_ok=${summary.strictOk}`,
    `strict_fail=${summary.strictFail}`,
    `strict_fail_budget=${strictFailBudget}`,
    `strict_pass_rate=${summary.strictPassRate}%`,
    `global_p95: ${formatStat(summary.globalP95)}`,
    `global_p99: ${formatStat(summary.globalP99)}`,
    `post_summary_p95: ${formatStat(summary.postP95)} non_ok=${summary.postNonOk} fail=${summary.postFail} warn=${summary.postWarn}`,
    `reel_summary_p95: ${formatStat(summary.reelP95)} non_ok=${summary.reelNonOk} fail=${summary.reelFail} warn=${summary.reelWarn}`,
    `bootstrap_full_p95: ${formatStat(summary.bootstrapP95)} non_ok=${summary.bootstrapNonOk} fail=${summary.bootstrapFail} warn=${summary.bootstrapWarn}`,
    `error_rate_percent: ${formatStat(summary.errRate)}`,
    `throttled_429_percent: ${formatStat(summary.throttled429Rate)}`,
    `first_sample=${summary.firstAt || "na"}`,
    `last_sample=${summary.lastAt || "na"}`,
    `samples_file=${samplesFile}`,
  ];

  console.log(`[feed-slo-report] ${title}`);
  lines.forEach((line) => console.log(`[feed-slo-report] ${line}`));

  if (noSend) return;

  const emailEnabled = isTruthy(
    process.env.FEED_SLO_REPORT_EMAIL_ENABLED !== undefined
      ? process.env.FEED_SLO_REPORT_EMAIL_ENABLED
      : "1"
  );
  const emailTo = String(
    process.env.FEED_SLO_REPORT_EMAIL ||
      process.env.FEED_CACHE_ALERT_EMAIL ||
      process.env.RISK_ALERT_EMAIL ||
      ""
  ).trim();
  const emailFrom = String(process.env.EMAIL_FROM || "Minhoo Alerts <noreply@minhoo.app>").trim();

  const telegramEnabled = isTruthy(
    process.env.FEED_SLO_REPORT_TELEGRAM_ENABLED !== undefined
      ? process.env.FEED_SLO_REPORT_TELEGRAM_ENABLED
      : process.env.FEED_CACHE_ALERT_TELEGRAM_ENABLED !== undefined
        ? process.env.FEED_CACHE_ALERT_TELEGRAM_ENABLED
        : "1"
  );
  const telegramToken = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const telegramChatId = String(
    process.env.FEED_SLO_REPORT_TELEGRAM_CHAT_ID ||
      process.env.FEED_CACHE_ALERT_TELEGRAM_CHAT_ID ||
      process.env.TELEGRAM_CHAT_ID ||
      ""
  ).trim();
  const telegramThreadId = String(
    process.env.FEED_SLO_REPORT_TELEGRAM_THREAD_ID ||
      process.env.FEED_CACHE_ALERT_TELEGRAM_THREAD_ID ||
      process.env.TELEGRAM_THREAD_ID ||
      ""
  ).trim();
  const telegramHttpFamily = (() => {
    const parsed = Number(
      process.env.FEED_SLO_REPORT_TELEGRAM_HTTP_FAMILY ||
        process.env.FEED_CACHE_ALERT_TELEGRAM_HTTP_FAMILY ||
        process.env.TELEGRAM_HTTP_FAMILY ||
        4
    );
    return Number.isFinite(parsed) && (parsed === 4 || parsed === 6) ? parsed : 4;
  })();

  const bodyHtml = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;

  let emailSent = false;
  let telegramSent = false;
  const errors = [];

  if (emailEnabled && emailTo) {
    try {
      await sendEmail({
        to: emailTo,
        from: emailFrom,
        subject: sendTest ? `[TEST] ${title}` : title,
        html: bodyHtml,
      });
      emailSent = true;
    } catch (error) {
      errors.push(`email: ${String(error?.message || error)}`);
    }
  }

  if (telegramEnabled && telegramToken && telegramChatId) {
    try {
      await sendTelegram({
        token: telegramToken,
        chatId: telegramChatId,
        threadId: telegramThreadId,
        title: sendTest ? `[TEST] ${title}` : title,
        bodyHtml: escapeHtml(lines.join("\n")),
        family: telegramHttpFamily,
      });
      telegramSent = true;
    } catch (error) {
      errors.push(`telegram: ${String(error?.message || error)}`);
    }
  }

  if (!emailSent && !telegramSent) {
    if (errors.length > 0) {
      throw new Error(`report not sent (${errors.join(" | ")})`);
    }
    console.log("[feed-slo-report] no channels configured, report printed only");
    return;
  }

  console.log(`[feed-slo-report] sent email=${emailSent ? "yes" : "no"} telegram=${telegramSent ? "yes" : "no"}`);
};

main().catch((error) => {
  console.error(`[feed-slo-report] ${String(error?.message || error)}`);
  process.exit(1);
});
