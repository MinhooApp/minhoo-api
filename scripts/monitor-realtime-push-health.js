#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const { execSync } = require("child_process");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag, fallback = "") => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  return String(argv[idx + 1] ?? fallback).trim();
};

const SERVICE = getArgValue("--service", process.env.MONITOR_SERVICE || "minhoo-api");
const SINCE_MINUTES = Math.max(1, Math.min(Number(getArgValue("--minutes", process.env.MONITOR_MINUTES || "15")) || 15, 720));
const MAX_HTTP_5XX = Math.max(0, Number(getArgValue("--max-http-5xx", process.env.MONITOR_MAX_HTTP_5XX || "0")) || 0);
const MIN_REALTIME_EVENTS = Math.max(0, Number(getArgValue("--min-realtime-events", process.env.MONITOR_MIN_REALTIME_EVENTS || "1")) || 1);
const MIN_PUSH_SUCCESS = Math.max(0, Number(getArgValue("--min-push-success", process.env.MONITOR_MIN_PUSH_SUCCESS || "0")) || 0);
const STRICT = hasFlag("--strict");
const JSON_MODE = hasFlag("--json");

const metrics = {
  service: SERVICE,
  since_minutes: SINCE_MINUTES,
  lines_total: 0,
  push_success_single: 0,
  push_success_multicast: 0,
  push_errors: 0,
  push_token_invalid: 0,
  push_not_configured: 0,
  push_init_failed: 0,
  push_locale_logs: 0,
  realtime_events: 0,
  realtime_chat_message: 0,
  realtime_chats_refresh: 0,
  resp_metrics_5xx: 0,
  resp_metrics_4xx: 0,
  resp_metrics_401_chat: 0,
  perf_warnings: 0,
};

const risks = [];
const warnings = [];

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
};

const runJournal = () => {
  const cmd = `journalctl -u ${SERVICE}.service --since "${SINCE_MINUTES} minutes ago" --no-pager -o cat`;
  try {
    return String(execSync(cmd, { encoding: "utf8" }));
  } catch (error) {
    const stderr = String(error?.stderr || "");
    const stdout = String(error?.stdout || "");
    const msg = `${stdout}${stderr}`.trim() || String(error?.message || error);
    throw new Error(`journalctl failed: ${msg}`);
  }
};

const parseLines = (raw) => {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  metrics.lines_total = lines.length;

  for (const line of lines) {
    if (line.includes("✅ Push (single) enviado")) metrics.push_success_single += 1;
    if (line.includes("✅ Push (multicast) enviado")) metrics.push_success_multicast += 1;
    if (line.includes("Firebase credentials are not configured")) metrics.push_not_configured += 1;
    if (line.includes("[push] Firebase admin init failed")) metrics.push_init_failed += 1;
    if (line.includes("🔥 Error enviando push (single)") || line.includes("❌ Error enviando push (multicast)")) {
      metrics.push_errors += 1;
    }
    if (line.includes("Token inválido") || line.includes("Token no registrado") || line.includes("UUID inválido")) {
      metrics.push_token_invalid += 1;
    }
    if (line.includes("[push][locale]")) metrics.push_locale_logs += 1;

    if (line.includes("[realtime-direct]")) metrics.realtime_events += 1;
    if (line.includes("[realtime-direct] chat message")) metrics.realtime_chat_message += 1;
    if (line.includes("[realtime-direct] chats refresh")) metrics.realtime_chats_refresh += 1;

    if (line.includes("[perf-warning]")) metrics.perf_warnings += 1;

    const respMatch = line.match(/\[resp-metrics\]\s+(\{.*\})$/);
    if (respMatch) {
      const payload = safeJsonParse(respMatch[1]);
      const status = Number(payload?.status_code || 0);
      const route = String(payload?.route || "");

      if (status >= 500) metrics.resp_metrics_5xx += 1;
      if (status >= 400 && status < 500) metrics.resp_metrics_4xx += 1;
      if (status === 401 && route === "/api/v1/chat") metrics.resp_metrics_401_chat += 1;
    }
  }
};

const evaluate = () => {
  const pushSuccessTotal = metrics.push_success_single + metrics.push_success_multicast;

  if (metrics.lines_total === 0) {
    warnings.push(
      `No logs found in the last ${SINCE_MINUTES} minutes for ${SERVICE}.service`
    );
  }

  if (metrics.push_not_configured > 0) {
    risks.push("Firebase push credentials are not configured on this service instance");
  }

  if (metrics.push_init_failed > 0) {
    risks.push("Firebase admin initialization failed");
  }

  if (metrics.push_errors > 0) {
    risks.push(`Push send errors detected: ${metrics.push_errors}`);
  }

  if (metrics.resp_metrics_5xx > MAX_HTTP_5XX) {
    risks.push(
      `HTTP 5xx responses exceed threshold: ${metrics.resp_metrics_5xx} > ${MAX_HTTP_5XX}`
    );
  }

  if (metrics.realtime_events < MIN_REALTIME_EVENTS) {
    warnings.push(
      `Realtime events below threshold: ${metrics.realtime_events} < ${MIN_REALTIME_EVENTS}`
    );
  }

  if (pushSuccessTotal < MIN_PUSH_SUCCESS) {
    warnings.push(
      `Push success events below threshold: ${pushSuccessTotal} < ${MIN_PUSH_SUCCESS}`
    );
  }

  if (metrics.perf_warnings > 0) {
    warnings.push(`Performance warnings detected: ${metrics.perf_warnings}`);
  }
};

const printHuman = () => {
  const pushSuccessTotal = metrics.push_success_single + metrics.push_success_multicast;

  console.log("[monitor] realtime/push health summary");
  console.log(`[monitor] service=${metrics.service} since=${metrics.since_minutes}m lines=${metrics.lines_total}`);
  console.log(
    `[monitor] push success(single=${metrics.push_success_single}, multicast=${metrics.push_success_multicast}, total=${pushSuccessTotal}) errors=${metrics.push_errors} token_issues=${metrics.push_token_invalid}`
  );
  console.log(
    `[monitor] realtime events=${metrics.realtime_events} chat_message=${metrics.realtime_chat_message} chats_refresh=${metrics.realtime_chats_refresh}`
  );
  console.log(
    `[monitor] resp 5xx=${metrics.resp_metrics_5xx} 4xx=${metrics.resp_metrics_4xx} chat401=${metrics.resp_metrics_401_chat}`
  );

  if (risks.length) {
    for (const risk of risks) {
      console.log(`[monitor][HIGH] ${risk}`);
    }
  }

  if (warnings.length) {
    for (const warning of warnings) {
      console.log(`[monitor][WARN] ${warning}`);
    }
  }

  if (!risks.length && !warnings.length) {
    console.log("[monitor] healthy");
  }
};

const main = () => {
  try {
    const logs = runJournal();
    parseLines(logs);
  } catch (error) {
    const message = String(error?.message || error);
    risks.push(message);
  }

  evaluate();

  const payload = {
    ok: risks.length === 0 && (!STRICT || warnings.length === 0),
    strict: STRICT,
    metrics,
    risks,
    warnings,
    generated_at: new Date().toISOString(),
  };

  if (JSON_MODE) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printHuman();
  }

  if (!payload.ok) {
    process.exitCode = 1;
  }
};

main();
