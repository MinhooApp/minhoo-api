#!/usr/bin/env node

/* eslint-disable no-console */
const axios = require("axios");
const nodemailer = require("nodemailer");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const explicitEnvFile = String(process.env.RISK_ENV_FILE || process.env.ENV_FILE || "").trim();
if (explicitEnvFile) {
  require("dotenv").config({
    path: path.resolve(process.cwd(), explicitEnvFile),
    override: true,
  });
}

applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: process.cwd() });

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return "";
  return String(argv[idx + 1] ?? "").trim();
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};
const toFiniteNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const toPositiveNumber = (value, fallback, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
};

const SEND_TEST_EMAIL = hasFlag("--send-test-email") || hasFlag("--send-test-all");
const SEND_TEST_TELEGRAM = hasFlag("--send-test-telegram") || hasFlag("--send-test-all");
const ALERT_EMAIL = getArgValue("--email") || process.env.RISK_ALERT_EMAIL || "info@minhoo.app";
const INTERNAL_DEBUG_TOKEN = String(process.env.INTERNAL_DEBUG_TOKEN || "").trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://api.minhoo.xyz").replace(/\/+$/, "");
const BLUE_API_BASE_URL = String(process.env.BLUE_API_BASE_URL || "http://127.0.0.1:3000").replace(
  /\/+$/,
  ""
);
const GREEN_API_BASE_URL = String(process.env.GREEN_API_BASE_URL || "http://127.0.0.1:3001").replace(
  /\/+$/,
  ""
);
const RISK_CHECK_GREEN_ENABLED = isTruthy(String(process.env.RISK_CHECK_GREEN_ENABLED || "1"));
const SMOKE_BOOTSTRAP_PATH =
  "/api/v1/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5";
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID =
  getArgValue("--telegram-chat-id") || String(process.env.TELEGRAM_CHAT_ID || "").trim();
const TELEGRAM_THREAD_ID_RAW =
  getArgValue("--telegram-thread-id") || String(process.env.TELEGRAM_THREAD_ID || "").trim();
const TELEGRAM_ENABLED = (() => {
  const raw = String(process.env.RISK_ALERT_TELEGRAM_ENABLED || "").trim();
  if (!raw) return true;
  return isTruthy(raw);
})();
const TELEGRAM_THREAD_ID = (() => {
  const parsed = Number(TELEGRAM_THREAD_ID_RAW);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
})();
const RISK_ALERT_REMINDER_MINUTES = toPositiveNumber(
  process.env.RISK_ALERT_REMINDER_MINUTES,
  30,
  1
);
const RISK_ALERT_REMINDER_MS = RISK_ALERT_REMINDER_MINUTES * 60 * 1000;
const TELEGRAM_HTTP_FAMILY = (() => {
  const parsed = Number(process.env.TELEGRAM_HTTP_FAMILY || 4);
  return Number.isFinite(parsed) && (parsed === 4 || parsed === 6) ? parsed : 4;
})();
const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : "";
const CPU_COUNT = Math.max(1, Math.trunc(toPositiveNumber(process.env.RISK_CPU_COUNT_OVERRIDE, os.cpus().length, 1)));
const MONITOR_STATE_FILE = String(
  process.env.RISK_MONITOR_STATE_FILE || "/tmp/minhoo-risk-monitor-state.json"
).trim();
const BASELINE_SAFE_RPS = toPositiveNumber(process.env.RISK_BASELINE_SAFE_RPS, 55, 1);
const CAPACITY_WARN_PCT = toPositiveNumber(process.env.RISK_CAPACITY_WARN_PCT, 70, 1);
const CAPACITY_SCALE_PCT = toPositiveNumber(process.env.RISK_CAPACITY_SCALE_PCT, 80, 1);
const CAPACITY_CRITICAL_PCT = toPositiveNumber(process.env.RISK_CAPACITY_CRITICAL_PCT, 90, 1);
const OBSERVABILITY_WINDOW = toPositiveNumber(process.env.RISK_OBSERVABILITY_WINDOW, 300, 20);
const OBSERVABILITY_MIN_REQUESTS = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_MIN_REQUESTS,
  30,
  1
);
const OBSERVABILITY_MIN_REQUESTS_GRACE_MINUTES = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_MIN_REQUESTS_GRACE_MINUTES,
  10,
  1
);
const OBSERVABILITY_P95_WARN_MS = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_P95_WARN_MS,
  900,
  50
);
const OBSERVABILITY_P99_WARN_MS = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_P99_WARN_MS,
  1500,
  100
);
const OBSERVABILITY_5XX_WARN_PCT = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_5XX_WARN_PCT,
  1.5,
  0.1
);
const OBSERVABILITY_429_WARN_PCT = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_429_WARN_PCT,
  4,
  0.1
);
const OBSERVABILITY_BOOTSTRAP_HIT_MIN_PCT = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_BOOTSTRAP_HIT_MIN_PCT,
  55,
  1
);
const OBSERVABILITY_BOOTSTRAP_NOTIF_HIT_MIN_PCT = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_BOOTSTRAP_NOTIF_HIT_MIN_PCT,
  45,
  1
);
const OBSERVABILITY_CACHE_MIN_SAMPLES = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_CACHE_MIN_SAMPLES,
  100,
  1
);
const OBSERVABILITY_HOTSPOT_P95_WARN_MS = toPositiveNumber(
  process.env.RISK_OBSERVABILITY_HOTSPOT_P95_WARN_MS,
  1800,
  100
);
const MIN_MEM_AVAILABLE_MB = toPositiveNumber(process.env.RISK_MIN_MEM_AVAILABLE_MB, 700, 64);
const LOAD_WARN_FACTOR = toPositiveNumber(process.env.RISK_LOAD_WARN_FACTOR, 1.75, 0.5);
const LOAD_CRITICAL_FACTOR = toPositiveNumber(process.env.RISK_LOAD_CRITICAL_FACTOR, 2.2, 0.5);
const SCALE_HINT =
  String(process.env.RISK_SCALE_ACTION_HINT || "")
    .trim() ||
  "Escalar ahora: aumentar tamano de VM (4vCPU/8GB) o agregar un segundo host detras del balanceador.";

const nowIso = () => new Date().toISOString();
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const toByteLength = (value) => {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value));
};
const telegramConfigured = TELEGRAM_BOT_TOKEN.length > 0 && TELEGRAM_CHAT_ID.length > 0;
const telegramReady = TELEGRAM_ENABLED && telegramConfigured;
const maskTail = (value, tailSize = 4) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "<empty>";
  if (raw.length <= tailSize) return "*".repeat(raw.length);
  return `${"*".repeat(raw.length - tailSize)}${raw.slice(-tailSize)}`;
};
const escapeHtml = (value) => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};
const clampTelegramText = (value, maxLen = 3900) => {
  const text = String(value ?? "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 32)}\n... (recortado por monitor)`;
};
const parseLoadFromUptime = (raw) => {
  const match = String(raw ?? "").match(/load average:\s*([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)/i);
  if (!match) return { load_1m: null, load_5m: null, load_15m: null };
  return {
    load_1m: toFiniteNumber(match[1], null),
    load_5m: toFiniteNumber(match[2], null),
    load_15m: toFiniteNumber(match[3], null),
  };
};
const parseMemAvailableMb = (raw) => {
  const lines = String(raw ?? "").split(/\r?\n/);
  const memLine = lines.find((line) => /^Mem:\s+/i.test(line));
  if (!memLine) return null;
  const cols = memLine.trim().split(/\s+/);
  if (cols.length < 7) return null;
  return toFiniteNumber(cols[6], null);
};
const parseStubStatus = (raw) => {
  const text = String(raw ?? "");
  const active = toFiniteNumber((text.match(/Active connections:\s*(\d+)/i) || [])[1], null);
  const totalsMatch = text.match(/server accepts handled requests\s+(\d+)\s+(\d+)\s+(\d+)/i);
  const rwMatch = text.match(/Reading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/i);
  return {
    active_connections: active,
    accepts_total: totalsMatch ? toFiniteNumber(totalsMatch[1], null) : null,
    handled_total: totalsMatch ? toFiniteNumber(totalsMatch[2], null) : null,
    requests_total: totalsMatch ? toFiniteNumber(totalsMatch[3], null) : null,
    reading: rwMatch ? toFiniteNumber(rwMatch[1], null) : null,
    writing: rwMatch ? toFiniteNumber(rwMatch[2], null) : null,
    waiting: rwMatch ? toFiniteNumber(rwMatch[3], null) : null,
  };
};
const readMonitorState = () => {
  try {
    const raw = fs.readFileSync(MONITOR_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (_error) {
    return null;
  }
};
const writeMonitorState = (state) => {
  try {
    fs.writeFileSync(MONITOR_STATE_FILE, `${JSON.stringify(state)}\n`, "utf8");
  } catch (error) {
    console.warn(`[monitor-state] write failed: ${String(error?.message || error)}`);
  }
};
const toEpochMs = (value) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fromDate = Date.parse(String(value || ""));
  if (Number.isFinite(fromDate) && fromDate > 0) return fromDate;
  return 0;
};
const buildRiskSignature = (risks) => {
  if (!Array.isArray(risks) || risks.length === 0) return "";
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/0x[0-9a-f]+/gi, "#")
      .replace(/\b\d+(?:\.\d+)?\b/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  const canonical = [...risks]
    .map((item) => normalize(item))
    .filter(Boolean)
    .sort()
    .join("\n");
  if (!canonical) return "";
  return crypto.createHash("sha1").update(canonical).digest("hex");
};
const readAlertState = () => {
  const state = readMonitorState();
  if (!state || typeof state !== "object") return {};
  const nested = state.alert_state;
  if (!nested || typeof nested !== "object") return {};
  return nested;
};
const writeAlertState = (alertState) => {
  const previous = readMonitorState() || {};
  const next = {
    ...previous,
    alert_state: {
      ...(previous.alert_state || {}),
      ...(alertState || {}),
    },
  };
  writeMonitorState(next);
};
const probeSystemSnapshot = () => {
  let load_1m = null;
  let load_5m = null;
  let load_15m = null;
  let mem_available_mb = null;

  try {
    const uptimeRaw = String(execSync("uptime", { encoding: "utf8" })).trim();
    const load = parseLoadFromUptime(uptimeRaw);
    load_1m = load.load_1m;
    load_5m = load.load_5m;
    load_15m = load.load_15m;
  } catch (_error) {
    // ignore
  }

  try {
    const freeRaw = String(execSync("free -m", { encoding: "utf8" })).trim();
    mem_available_mb = parseMemAvailableMb(freeRaw);
  } catch (_error) {
    // ignore
  }

  return {
    cpu_count: CPU_COUNT,
    load_1m,
    load_5m,
    load_15m,
    mem_available_mb,
    load_warn_threshold_5m: round2(CPU_COUNT * LOAD_WARN_FACTOR),
    load_critical_threshold_5m: round2(CPU_COUNT * LOAD_CRITICAL_FACTOR),
    mem_warn_threshold_mb: MIN_MEM_AVAILABLE_MB,
  };
};
const probeNginxStubStatus = async () => {
  const started = nowMs();
  try {
    const response = await axios.get("http://127.0.0.1/stub_status", {
      timeout: 8000,
      validateStatus: () => true,
    });
    const durationMs = round2(nowMs() - started);
    if (response.status !== 200) {
      return {
        type: "infra",
        name: "nginx_stub_status",
        ok: false,
        status: response.status,
        duration_ms: durationMs,
      };
    }
    const parsed = parseStubStatus(response.data);
    return {
      type: "infra",
      name: "nginx_stub_status",
      ok: true,
      status: response.status,
      duration_ms: durationMs,
      ...parsed,
    };
  } catch (error) {
    return {
      type: "infra",
      name: "nginx_stub_status",
      ok: false,
      status: 0,
      duration_ms: round2(nowMs() - started),
      error: String(error?.message || error),
    };
  }
};
const computeCapacityTelemetry = (stubStatus) => {
  const nowAtMs = Date.now();
  const previous = readMonitorState();
  const previousTsMs = toFiniteNumber(previous?.capacity?.ts_ms ?? previous?.ts_ms, null);
  const previousRequestsTotal = toFiniteNumber(
    previous?.capacity?.requests_total ?? previous?.requests_total,
    null
  );
  const currentRequests = toFiniteNumber(stubStatus?.requests_total, null);
  let observed_rps = null;
  let sample_seconds = null;
  let requests_delta = null;
  let utilization_percent = null;

  if (
    previous &&
    Number.isFinite(previousTsMs) &&
    Number.isFinite(previousRequestsTotal) &&
    Number.isFinite(currentRequests)
  ) {
    sample_seconds = (nowAtMs - Number(previousTsMs)) / 1000;
    requests_delta = Number(currentRequests) - Number(previousRequestsTotal);
    if (sample_seconds >= 10 && requests_delta >= 0) {
      observed_rps = round2(requests_delta / sample_seconds);
      utilization_percent = round2((observed_rps / BASELINE_SAFE_RPS) * 100);
    }
  }

  if (Number.isFinite(currentRequests)) {
    const capacityState = {
      ts_ms: nowAtMs,
      requests_total: Number(currentRequests),
    };
    writeMonitorState({
      ...(previous || {}),
      ...capacityState,
      capacity: capacityState,
    });
  }

  return {
    observed_rps,
    sample_seconds: Number.isFinite(sample_seconds) ? round2(sample_seconds) : null,
    requests_delta: Number.isFinite(requests_delta) ? requests_delta : null,
    baseline_safe_rps: BASELINE_SAFE_RPS,
    utilization_percent,
    threshold_warn_pct: CAPACITY_WARN_PCT,
    threshold_scale_pct: CAPACITY_SCALE_PCT,
    threshold_critical_pct: CAPACITY_CRITICAL_PCT,
    scale_recommendation: SCALE_HINT,
  };
};

const smtpReady = () => {
  return (
    String(process.env.EMAIL_HOST || "").trim().length > 0 &&
    String(process.env.EMAIL_PORT || "").trim().length > 0 &&
    String(process.env.EMAIL_USER || "").trim().length > 0 &&
    String(process.env.EMAIL_PASS || "").trim().length > 0
  );
};

const createTransporter = () => {
  const allowInsecureTls = String(process.env.EMAIL_ALLOW_INSECURE_TLS || "").trim() === "1";
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      rejectUnauthorized: !allowInsecureTls,
    },
  });
};

const sendEmail = async ({ to, subject, html }) => {
  if (!smtpReady()) {
    throw new Error("Configuracion SMTP incompleta (EMAIL_HOST/PORT/USER/PASS)");
  }
  const transporter = createTransporter();
  const from = String(process.env.EMAIL_FROM || process.env.EMAIL_USER || "Minhoo <noreply@minhoo.app>");
  await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
};

const sendTelegram = async ({ text }) => {
  if (!telegramReady) {
    throw new Error("Telegram no esta configurado (definir TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID)");
  }
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: clampTelegramText(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (TELEGRAM_THREAD_ID) payload.message_thread_id = TELEGRAM_THREAD_ID;

  const response = await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, payload, {
    timeout: 15_000,
    family: TELEGRAM_HTTP_FAMILY,
    validateStatus: () => true,
  });
  if (!(response.status >= 200 && response.status < 300) || response.data?.ok !== true) {
    const reason =
      response.data?.description ||
      response.data?.error_code ||
      `http_status=${response.status}`;
    throw new Error(`Fallo sendMessage de Telegram (${reason})`);
  }
  return Number(response.data?.result?.message_id || 0) || null;
};

const probeHttp = async ({ name, url, expected = [200], timeout = 15000, headers = {}, warnMs = 1000 }) => {
  const started = nowMs();
  try {
    const response = await axios.get(url, {
      headers,
      timeout,
      responseType: "arraybuffer",
      validateStatus: () => true,
    });
    const durationMs = round2(nowMs() - started);
    const bytes = Number(response.headers["content-length"] || 0) || toByteLength(response.data);
    const ok = expected.includes(response.status);
    const slow = durationMs > warnMs;
    return {
      type: "http",
      name,
      url,
      ok,
      slow,
      warn_ms: warnMs,
      status: response.status,
      duration_ms: durationMs,
      bytes,
    };
  } catch (error) {
    return {
      type: "http",
      name,
      url,
      ok: false,
      slow: false,
      warn_ms: warnMs,
      status: 0,
      duration_ms: round2(nowMs() - started),
      bytes: 0,
      error: String(error && error.message ? error.message : error),
    };
  }
};

const probePing = async ({ name, url, expected = [200], timeout = 15000, warnMs = 400, instance }) => {
  const started = nowMs();
  try {
    const response = await axios.get(url, {
      timeout,
      validateStatus: () => true,
    });
    const durationMs = round2(nowMs() - started);
    const ok = expected.includes(response.status);
    const slow = durationMs > warnMs;
    const uptimeSecondsRaw =
      response?.data?.uptime_seconds ??
      response?.data?.body?.uptime_seconds ??
      response?.data?.body?.uptime ??
      null;
    const uptimeSeconds = toFiniteNumber(uptimeSecondsRaw, null);
    return {
      type: "http",
      name,
      url,
      ok,
      slow,
      warn_ms: warnMs,
      status: response.status,
      duration_ms: durationMs,
      bytes: toByteLength(response.data),
      instance: String(instance || "").trim() || undefined,
      uptime_seconds: Number.isFinite(uptimeSeconds) ? round2(uptimeSeconds) : null,
    };
  } catch (error) {
    return {
      type: "http",
      name,
      url,
      ok: false,
      slow: false,
      warn_ms: warnMs,
      status: 0,
      duration_ms: round2(nowMs() - started),
      bytes: 0,
      instance: String(instance || "").trim() || undefined,
      error: String(error && error.message ? error.message : error),
    };
  }
};

const extractObservabilityPayload = (payload) => {
  const byBody = payload?.body?.observability;
  if (byBody && typeof byBody === "object") return byBody;
  if (payload?.observability && typeof payload.observability === "object") return payload.observability;
  return null;
};

const probeObservabilityOverview = ({ headers = {}, baseUrl = BLUE_API_BASE_URL, instance = "blue" } = {}) => {
  return (async () => {
  const started = nowMs();
  const url = `${String(baseUrl || "").replace(/\/+$/, "")}/api/v1/internal/observability/overview?window=${OBSERVABILITY_WINDOW}`;
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 12000,
      validateStatus: () => true,
    });
    const durationMs = round2(nowMs() - started);
    const bytes = toByteLength(response.data);
    if (response.status !== 200) {
      return {
        type: "observability",
        name: `${String(instance || "unknown")}_internal_observability_overview`,
        url,
        ok: false,
        status: response.status,
        duration_ms: durationMs,
        bytes,
      };
    }

    const observability = extractObservabilityPayload(response.data);
    if (!observability) {
      return {
        type: "observability",
        name: `${String(instance || "unknown")}_internal_observability_overview`,
        url,
        ok: false,
        status: response.status,
        duration_ms: durationMs,
        bytes,
        error: "observability payload missing",
      };
    }

    const metrics = observability.response_metrics || {};
    const totals = metrics.totals || {};
    const bootstrapCache = metrics.bootstrap_cache || {};
    const bootstrapNotificationsCache = metrics.bootstrap_notifications_cache || {};
    const bootstrapSamplesTotal =
      toFiniteNumber(bootstrapCache.hit, 0) +
      toFiniteNumber(bootstrapCache.miss, 0) +
      toFiniteNumber(bootstrapCache.coalesced, 0) +
      toFiniteNumber(bootstrapCache.bypass, 0) +
      toFiniteNumber(bootstrapCache.other, 0);
    const bootstrapNotificationsSamplesTotal =
      toFiniteNumber(bootstrapNotificationsCache.hit, 0) +
      toFiniteNumber(bootstrapNotificationsCache.miss, 0) +
      toFiniteNumber(bootstrapNotificationsCache.coalesced, 0) +
      toFiniteNumber(bootstrapNotificationsCache.bypass, 0) +
      toFiniteNumber(bootstrapNotificationsCache.other, 0);
    const hotspots = Array.isArray(metrics.hotspots) ? metrics.hotspots : [];
    const topHotspot = hotspots[0] || null;

    return {
      type: "observability",
      name: `${String(instance || "unknown")}_internal_observability_overview`,
      url,
      ok: true,
      status: response.status,
      duration_ms: durationMs,
      bytes,
      generated_at: observability.generated_at || null,
      instance: String(instance || "").trim() || "unknown",
      requests: toFiniteNumber(totals.requests, 0),
      p50_ms: toFiniteNumber(totals.p50_ms, null),
      p95_ms: toFiniteNumber(totals.p95_ms, null),
      p99_ms: toFiniteNumber(totals.p99_ms, null),
      avg_ms: toFiniteNumber(totals.avg_ms, null),
      error_rate_percent: toFiniteNumber(totals.error_rate_percent, null),
      throttled_429_rate_percent: toFiniteNumber(totals.throttled_429_rate_percent, null),
      bootstrap_hit_rate_percent: toFiniteNumber(bootstrapCache.hit_rate_percent, null),
      bootstrap_samples_total: Number.isFinite(bootstrapSamplesTotal) ? bootstrapSamplesTotal : 0,
      bootstrap_notifications_hit_rate_percent: toFiniteNumber(
        bootstrapNotificationsCache.hit_rate_percent,
        null
      ),
      bootstrap_notifications_samples_total: Number.isFinite(bootstrapNotificationsSamplesTotal)
        ? bootstrapNotificationsSamplesTotal
        : 0,
      hotspot_route: topHotspot
        ? `${String(topHotspot.method || "GET")} ${String(topHotspot.route || "")}:${
            topHotspot.summary ? "summary" : "full"
          }`
        : null,
      hotspot_p95_ms: toFiniteNumber(topHotspot?.p95_ms, null),
    };
  } catch (error) {
    return {
      type: "observability",
      name: `${String(instance || "unknown")}_internal_observability_overview`,
      url,
      ok: false,
      status: 0,
      duration_ms: round2(nowMs() - started),
      bytes: 0,
      instance: String(instance || "").trim() || "unknown",
      error: String(error?.message || error),
    };
  }
  })();
};

const probeServiceActive = (service) => {
  try {
    const result = String(execSync(`systemctl is-active ${service}`, { encoding: "utf8" })).trim();
    return {
      type: "service",
      name: `service_${service}`,
      service,
      ok: result === "active",
      state: result,
    };
  } catch (_error) {
    return {
      type: "service",
      name: `service_${service}`,
      service,
      ok: false,
      state: "unknown",
    };
  }
};

const formatRiskRows = (risks) => {
  if (!risks.length) return "<li>No se detectaron riesgos.</li>";
  return risks.map((risk) => `<li>${risk}</li>`).join("");
};

const formatCheckRows = (checks) => {
  return checks
    .map((check) => {
      if (check.type === "service") {
        return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FALLA"}</td><td>${check.state}</td><td>-</td><td>-</td></tr>`;
      }
      if (check.type === "infra" && check.name === "nginx_stub_status") {
        const state = check.ok
          ? `active=${check.active_connections} reading=${check.reading} writing=${check.writing} waiting=${check.waiting}`
          : `status=${check.status}`;
        return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FALLA"}</td><td>${state}</td><td>${check.duration_ms} ms</td><td>-</td></tr>`;
      }
      if (check.type === "observability") {
        const state = check.ok
          ? `req=${check.requests} p95=${check.p95_ms}ms p99=${check.p99_ms}ms 5xx=${check.error_rate_percent}% 429=${check.throttled_429_rate_percent}%`
          : `status=${check.status}`;
        return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FALLA"}</td><td>${state}</td><td>${check.duration_ms} ms</td><td>${check.bytes}</td></tr>`;
      }
      return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FALLA"}</td><td>${check.status}</td><td>${check.duration_ms} ms</td><td>${check.bytes}</td></tr>`;
    })
    .join("");
};
const formatTelegramRiskMessage = ({ summary, checks, risks, reason }) => {
  const failedChecks = checks.filter((check) => !check.ok);
  const slowChecks = checks.filter((check) => check.type === "http" && check.ok && check.slow);
  const actions = Array.isArray(summary?.recommended_actions) ? summary.recommended_actions : [];
  const capacity = summary?.capacity || {};
  const lines = [];
  lines.push("<b>Alerta de Riesgo en Produccion - Minhoo</b>");
  lines.push(`Hora: <code>${escapeHtml(summary.at)}</code>`);
  lines.push(`Cantidad de riesgos: <b>${risks.length}</b>`);
  if (reason) lines.push(`Motivo del envio: <b>${escapeHtml(reason)}</b>`);
  lines.push(`Checks fallidos: <b>${failedChecks.length}</b>`);
  lines.push(`Checks lentos: <b>${slowChecks.length}</b>`);
  if (Number.isFinite(capacity?.utilization_percent)) {
    lines.push(
      `Capacidad: <b>${escapeHtml(capacity.utilization_percent)}%</b> (${escapeHtml(
        capacity.observed_rps
      )} rps / base segura ${escapeHtml(capacity.baseline_safe_rps)} rps)`
    );
  }
  const observability = summary?.observability || {};
  if (Number.isFinite(observability?.requests) && observability.requests >= 0) {
    lines.push(
      `Observabilidad: req=${escapeHtml(observability.requests)} p95=${escapeHtml(
        observability.p95_ms
      )}ms p99=${escapeHtml(observability.p99_ms)}ms 5xx=${escapeHtml(
        observability.error_rate_percent
      )}% 429=${escapeHtml(observability.throttled_429_rate_percent)}%`
    );
    lines.push(
      `Cache bootstrap hit=${escapeHtml(
        observability.bootstrap_hit_rate_percent
      )}% notif_hit=${escapeHtml(observability.bootstrap_notifications_hit_rate_percent)}%`
    );
  }
  const byInstance = summary?.observability_by_instance || {};
  const instanceKeys = Object.keys(byInstance);
  if (instanceKeys.length > 1) {
    lines.push("");
    lines.push("<b>Observabilidad por instancia</b>");
    for (const key of instanceKeys) {
      const item = byInstance[key] || {};
      lines.push(
        `• ${escapeHtml(key)} req=${escapeHtml(item.requests)} p95=${escapeHtml(
          item.p95_ms
        )}ms p99=${escapeHtml(item.p99_ms)}ms 5xx=${escapeHtml(
          item.error_rate_percent
        )}% 429=${escapeHtml(item.throttled_429_rate_percent)}%`
      );
    }
  }
  lines.push("");
  lines.push("<b>Riesgos Principales</b>");
  if (!risks.length) {
    lines.push("• No se detectaron riesgos.");
  } else {
    for (const risk of risks.slice(0, 12)) {
      lines.push(`• ${escapeHtml(risk)}`);
    }
  }
  if (actions.length) {
    lines.push("");
    lines.push("<b>Acciones Recomendadas</b>");
    for (const action of actions.slice(0, 6)) {
      lines.push(`• ${escapeHtml(action)}`);
    }
  }
  lines.push("");
  lines.push(`URL base: <code>${escapeHtml(PUBLIC_BASE_URL)}</code>`);
  return lines.join("\n");
};
const formatTelegramRecoveryMessage = ({ summary, lastAlertState, clearedAfterMinutes }) => {
  const lines = [];
  lines.push("<b>Recuperado - Monitor Minhoo</b>");
  lines.push(`Hora: <code>${escapeHtml(summary.at)}</code>`);
  if (Number.isFinite(clearedAfterMinutes) && clearedAfterMinutes >= 0) {
    lines.push(`Riesgo estabilizado tras: <b>${escapeHtml(clearedAfterMinutes)} min</b>`);
  }
  if (lastAlertState?.last_risk_alert_reason) {
    lines.push(`Ultima alerta enviada como: <b>${escapeHtml(lastAlertState.last_risk_alert_reason)}</b>`);
  }
  lines.push("Estado actual: <b>sin riesgos</b>.");
  lines.push(`URL base: <code>${escapeHtml(PUBLIC_BASE_URL)}</code>`);
  return lines.join("\n");
};
const formatTelegramTestMessage = ({ summary, risks }) => {
  return [
    "<b>Prueba de Monitor Minhoo</b>",
    `Hora: <code>${escapeHtml(summary.at)}</code>`,
    `Cantidad de riesgos al momento de la prueba: <b>${risks.length}</b>`,
    "Si recibiste este mensaje, la entrega por Telegram funciona.",
  ].join("\n");
};

const main = async () => {
  const checks = [];
  const recommendedActions = [];
  const addAction = (action) => {
    const normalized = String(action ?? "").trim();
    if (!normalized) return;
    if (!recommendedActions.includes(normalized)) {
      recommendedActions.push(normalized);
    }
  };
  const systemSnapshot = probeSystemSnapshot();

  const internalHeaders = { "x-internal-debug": "true" };
  if (INTERNAL_DEBUG_TOKEN) internalHeaders["x-internal-debug-token"] = INTERNAL_DEBUG_TOKEN;

  checks.push(probeServiceActive("minhoo-api.service"));
  checks.push(probeServiceActive("nginx.service"));
  checks.push(probeServiceActive("mysql.service"));
  const nginxStubStatus = await probeNginxStubStatus();
  checks.push(nginxStubStatus);

  checks.push(
    await probePing({
      name: "blue_ping",
      instance: "blue",
      url: `${BLUE_API_BASE_URL}/api/v1/ping`,
      expected: [200],
      warnMs: 400,
    })
  );
  checks.push(
    await probeHttp({
      name: "public_ping",
      url: `${PUBLIC_BASE_URL}/api/v1/ping`,
      expected: [200],
      warnMs: 700,
    })
  );

  checks.push(
    await probeHttp({
      name: "blue_bootstrap",
      url: `${BLUE_API_BASE_URL}${SMOKE_BOOTSTRAP_PATH}`,
      expected: [200],
      warnMs: 1400,
    })
  );
  checks.push(
    await probeHttp({
      name: "public_bootstrap",
      url: `${PUBLIC_BASE_URL}${SMOKE_BOOTSTRAP_PATH}`,
      expected: [200],
      warnMs: 1800,
    })
  );

  checks.push(
    await probeHttp({
      name: "blue_catalog_countries",
      url: `${BLUE_API_BASE_URL}/api/v1/catalog/countries`,
      expected: [200],
      warnMs: 900,
    })
  );
  checks.push(
    await probeHttp({
      name: "blue_internal_summary_routes",
      url: `${BLUE_API_BASE_URL}/api/v1/internal/debug/summary-routes`,
      headers: internalHeaders,
      expected: [200],
      warnMs: 1000,
    })
  );
  checks.push(
    await probeHttp({
      name: "blue_internal_perf_check",
      url: `${BLUE_API_BASE_URL}/api/v1/internal/perf-check`,
      headers: internalHeaders,
      expected: [200],
      timeout: 30000,
      warnMs: 2500,
    })
  );
  checks.push(
    await probeObservabilityOverview({
      headers: internalHeaders,
      baseUrl: BLUE_API_BASE_URL,
      instance: "blue",
    })
  );

  if (RISK_CHECK_GREEN_ENABLED) {
    checks.push(
      await probePing({
        name: "green_ping",
        instance: "green",
        url: `${GREEN_API_BASE_URL}/api/v1/ping`,
        expected: [200],
        warnMs: 400,
      })
    );
    checks.push(
      await probeHttp({
        name: "green_bootstrap",
        url: `${GREEN_API_BASE_URL}${SMOKE_BOOTSTRAP_PATH}`,
        expected: [200],
        warnMs: 1400,
      })
    );
    checks.push(
      await probeHttp({
        name: "green_catalog_countries",
        url: `${GREEN_API_BASE_URL}/api/v1/catalog/countries`,
        expected: [200],
        warnMs: 900,
      })
    );
    checks.push(
      await probeHttp({
        name: "green_internal_summary_routes",
        url: `${GREEN_API_BASE_URL}/api/v1/internal/debug/summary-routes`,
        headers: internalHeaders,
        expected: [200],
        warnMs: 1000,
      })
    );
    checks.push(
      await probeHttp({
        name: "green_internal_perf_check",
        url: `${GREEN_API_BASE_URL}/api/v1/internal/perf-check`,
        headers: internalHeaders,
        expected: [200],
        timeout: 30000,
        warnMs: 2500,
      })
    );
    checks.push(
      await probeObservabilityOverview({
        headers: internalHeaders,
        baseUrl: GREEN_API_BASE_URL,
        instance: "green",
      })
    );
  }
  const risks = [];
  const pingByInstance = new Map();
  for (const check of checks) {
    if (check && check.type === "http" && /_ping$/.test(String(check.name || ""))) {
      const key = String(check.instance || check.name || "").toLowerCase();
      if (key) pingByInstance.set(key, check);
    }
  }
  for (const check of checks) {
    if (!check.ok) {
      if (check.type === "service") {
        risks.push(`[ALTA] Servicio caido o desconocido: ${check.service} (estado=${check.state})`);
        addAction(`Reiniciar y validar ${check.service} inmediatamente.`);
      } else if (check.type === "observability") {
        risks.push(
          `[ALTA] Check de observabilidad fallido: status=${check.status} duration_ms=${check.duration_ms} error=${
            check.error || "n/a"
          }`
        );
        addAction("Validar INTERNAL_DEBUG_TOKEN, endpoint interno y salud del proceso API.");
      } else {
        risks.push(
          `[ALTA] Check HTTP fallido: ${check.name} status=${check.status} duration_ms=${check.duration_ms} url=${check.url}`
        );
        addAction("Validar salud de upstream y revertir cambios recientes si aplica.");
      }
      continue;
    }
    if (check.type === "observability") {
      const pingRef = pingByInstance.get(String(check.instance || "blue").toLowerCase());
      const uptimeSeconds = toFiniteNumber(pingRef?.uptime_seconds, null);
      const withinLowSampleGrace =
        Number.isFinite(uptimeSeconds) &&
        uptimeSeconds < OBSERVABILITY_MIN_REQUESTS_GRACE_MINUTES * 60;

      if (check.requests < OBSERVABILITY_MIN_REQUESTS) {
        if (!withinLowSampleGrace) {
          risks.push(
            `[BAJA] Ventana de observabilidad con pocas muestras (${check.instance || "unknown"}): requests=${check.requests} minimo=${OBSERVABILITY_MIN_REQUESTS}`
          );
          addAction("Generar trafico controlado antes de evaluar latencias p95/p99.");
        }
      } else {
        if (Number.isFinite(check.p95_ms) && check.p95_ms > OBSERVABILITY_P95_WARN_MS) {
          risks.push(
            `[MEDIA] Latencia global p95 alta (${check.instance || "unknown"}): p95_ms=${check.p95_ms} umbral_ms=${OBSERVABILITY_P95_WARN_MS}`
          );
          addAction("Revisar hotspots del overview y caches de bootstrap/home.");
        }
        if (Number.isFinite(check.p99_ms) && check.p99_ms > OBSERVABILITY_P99_WARN_MS) {
          risks.push(
            `[MEDIA] Latencia global p99 alta (${check.instance || "unknown"}): p99_ms=${check.p99_ms} umbral_ms=${OBSERVABILITY_P99_WARN_MS}`
          );
          addAction("Auditar queries lentas y pool de DB para cola en p99.");
        }
        if (
          Number.isFinite(check.error_rate_percent) &&
          check.error_rate_percent >= OBSERVABILITY_5XX_WARN_PCT
        ) {
          risks.push(
            `[ALTA] Tasa de 5xx elevada (${check.instance || "unknown"}): error_rate_percent=${check.error_rate_percent}% umbral=${OBSERVABILITY_5XX_WARN_PCT}%`
          );
          addAction("Inspeccionar logs de errores 5xx y activar rollback si hay regresion.");
        }
        if (
          Number.isFinite(check.throttled_429_rate_percent) &&
          check.throttled_429_rate_percent >= OBSERVABILITY_429_WARN_PCT
        ) {
          risks.push(
            `[MEDIA] Tasa de 429 elevada (${check.instance || "unknown"}): throttled_429_rate_percent=${check.throttled_429_rate_percent}% umbral=${OBSERVABILITY_429_WARN_PCT}%`
          );
          addAction("Ajustar rate limits por ruta y validar burst control en cliente.");
        }
        if (
          Number.isFinite(check.bootstrap_hit_rate_percent) &&
          toFiniteNumber(check.bootstrap_samples_total, 0) >= OBSERVABILITY_CACHE_MIN_SAMPLES &&
          check.bootstrap_hit_rate_percent < OBSERVABILITY_BOOTSTRAP_HIT_MIN_PCT
        ) {
          risks.push(
            `[MEDIA] Cache hit bajo en bootstrap/home (${check.instance || "unknown"}): hit_rate=${check.bootstrap_hit_rate_percent}% minimo=${OBSERVABILITY_BOOTSTRAP_HIT_MIN_PCT}%`
          );
          addAction("Incrementar TTL o reducir bypass para mejorar hit-rate de bootstrap.");
        }
        if (
          Number.isFinite(check.bootstrap_notifications_hit_rate_percent) &&
          toFiniteNumber(check.bootstrap_notifications_samples_total, 0) >=
            OBSERVABILITY_CACHE_MIN_SAMPLES &&
          check.bootstrap_notifications_hit_rate_percent < OBSERVABILITY_BOOTSTRAP_NOTIF_HIT_MIN_PCT
        ) {
          risks.push(
            `[BAJA] Cache hit bajo en notifications de bootstrap (${check.instance || "unknown"}): hit_rate=${check.bootstrap_notifications_hit_rate_percent}% minimo=${OBSERVABILITY_BOOTSTRAP_NOTIF_HIT_MIN_PCT}%`
          );
          addAction("Revisar invalidaciones de notifications cache en eventos de follow/chat.");
        }
        if (
          Number.isFinite(check.hotspot_p95_ms) &&
          check.hotspot_p95_ms > OBSERVABILITY_HOTSPOT_P95_WARN_MS
        ) {
          risks.push(
            `[MEDIA] Hotspot lento detectado: route=${check.hotspot_route || "n/a"} p95_ms=${
              check.hotspot_p95_ms
            } umbral_ms=${OBSERVABILITY_HOTSPOT_P95_WARN_MS}`
          );
          addAction("Optimizar endpoint hotspot (indices, payload y cache selectivo).");
        }
      }
      continue;
    }
    if (check.type === "http" && check.slow) {
      risks.push(
        `[MEDIA] Endpoint lento: ${check.name} duration_ms=${check.duration_ms} umbral_ms=${check.warn_ms}`
      );
      addAction("Pausar deploys y vigilar tendencia de latencia por 15 minutos.");
    }
  }
  if (!nginxStubStatus.ok) {
    risks.push(
      `[MEDIA] Nginx stub_status no disponible: status=${nginxStubStatus.status} error=${nginxStubStatus.error || "n/a"}`
    );
    addAction("Revisar endpoint de salud de Nginx y reglas de firewall local.");
  }

  if (Number.isFinite(systemSnapshot.load_5m)) {
    if (systemSnapshot.load_5m >= systemSnapshot.load_critical_threshold_5m) {
      risks.push(
        `[ALTA] Presion de carga del host: load_5m=${systemSnapshot.load_5m} umbral=${systemSnapshot.load_critical_threshold_5m} (cpu=${CPU_COUNT})`
      );
      addAction("Escalar servidor ahora y posponer procesos pesados.");
    } else if (systemSnapshot.load_5m >= systemSnapshot.load_warn_threshold_5m) {
      risks.push(
        `[MEDIA] Carga del host elevada: load_5m=${systemSnapshot.load_5m} umbral=${systemSnapshot.load_warn_threshold_5m} (cpu=${CPU_COUNT})`
      );
      addAction("Preparar escalado y reducir cargas no criticas.");
    }
  }

  if (Number.isFinite(systemSnapshot.mem_available_mb) && systemSnapshot.mem_available_mb <= MIN_MEM_AVAILABLE_MB) {
    risks.push(
      `[ALTA] Margen de memoria bajo: available_mb=${systemSnapshot.mem_available_mb} umbral_mb=${MIN_MEM_AVAILABLE_MB}`
    );
    addAction("Escalar memoria de inmediato y revisar endpoints intensivos en memoria.");
  }

  const capacityTelemetry = computeCapacityTelemetry(nginxStubStatus);
  if (Number.isFinite(capacityTelemetry.utilization_percent)) {
    if (capacityTelemetry.utilization_percent >= CAPACITY_CRITICAL_PCT) {
      risks.push(
        `[ALTA] Capacidad critica: utilizacion=${capacityTelemetry.utilization_percent}% observed_rps=${capacityTelemetry.observed_rps} baseline_safe_rps=${BASELINE_SAFE_RPS}`
      );
      addAction(SCALE_HINT);
      addAction("Aplicar limites temporales hasta que la utilizacion baje de 80%.");
    } else if (capacityTelemetry.utilization_percent >= CAPACITY_SCALE_PCT) {
      risks.push(
        `[MEDIA] Capacidad en umbral de escalado: utilizacion=${capacityTelemetry.utilization_percent}% observed_rps=${capacityTelemetry.observed_rps} baseline_safe_rps=${BASELINE_SAFE_RPS}`
      );
      addAction(SCALE_HINT);
      addAction("Escalar ahora para evitar saturacion y mantener estable la latencia p95.");
    } else if (capacityTelemetry.utilization_percent >= CAPACITY_WARN_PCT) {
      risks.push(
        `[BAJA] Advertencia de capacidad: utilizacion=${capacityTelemetry.utilization_percent}% observed_rps=${capacityTelemetry.observed_rps} baseline_safe_rps=${BASELINE_SAFE_RPS}`
      );
      addAction("Preparar escalado; activar escalado proactivo al 80% de utilizacion.");
    }
  }

  if (!INTERNAL_DEBUG_TOKEN) {
    risks.push(
      "[BAJA] INTERNAL_DEBUG_TOKEN esta vacio en el entorno actual; checks internos pueden fallar."
    );
  }

  const observabilityCheck =
    checks.find((check) => check && check.type === "observability") || null;
  const observabilityByInstance = checks
    .filter((check) => check && check.type === "observability")
    .reduce((acc, check) => {
      const key = String(check.instance || "unknown");
      acc[key] = {
        requests: check.requests,
        p50_ms: check.p50_ms,
        p95_ms: check.p95_ms,
        p99_ms: check.p99_ms,
        avg_ms: check.avg_ms,
          error_rate_percent: check.error_rate_percent,
          throttled_429_rate_percent: check.throttled_429_rate_percent,
          bootstrap_hit_rate_percent: check.bootstrap_hit_rate_percent,
          bootstrap_samples_total: check.bootstrap_samples_total,
          bootstrap_notifications_hit_rate_percent: check.bootstrap_notifications_hit_rate_percent,
          bootstrap_notifications_samples_total: check.bootstrap_notifications_samples_total,
          hotspot_route: check.hotspot_route,
          hotspot_p95_ms: check.hotspot_p95_ms,
        };
      return acc;
    }, {});
  const previousAlertState = readAlertState();
  const nowAtEpochMs = Date.now();
  const previousRiskActive = Boolean(previousAlertState.risk_active);
  const previousRiskSignature = String(previousAlertState.risk_signature || "").trim();
  const previousLastRiskAlertAtMs = toEpochMs(previousAlertState.last_risk_alert_at_ms);
  const currentRiskSignature = buildRiskSignature(risks);
  const riskStartedAtMs = toEpochMs(
    previousAlertState.risk_started_at_ms || previousAlertState.risk_started_at
  );
  let shouldSendRiskAlert = false;
  let riskAlertReason = "suppressed";
  if (risks.length > 0) {
    if (!previousRiskActive) {
      shouldSendRiskAlert = true;
      riskAlertReason = "new";
    } else if (!previousLastRiskAlertAtMs) {
      shouldSendRiskAlert = true;
      riskAlertReason = "new";
    } else if (currentRiskSignature && currentRiskSignature !== previousRiskSignature) {
      shouldSendRiskAlert = true;
      riskAlertReason = "changed";
    } else if (nowAtEpochMs - previousLastRiskAlertAtMs >= RISK_ALERT_REMINDER_MS) {
      shouldSendRiskAlert = true;
      riskAlertReason = "reminder";
    }
  }
  const shouldSendRecoveryAlert = risks.length === 0 && previousRiskActive;
  const riskAlertSuppressed = risks.length > 0 && !shouldSendRiskAlert;
  const clearedAfterMinutes =
    shouldSendRecoveryAlert && riskStartedAtMs > 0
      ? round2((nowAtEpochMs - riskStartedAtMs) / 60000)
      : null;

  const summary = {
    at: nowIso(),
    alert_email: ALERT_EMAIL,
    send_test_email: SEND_TEST_EMAIL,
    send_test_telegram: SEND_TEST_TELEGRAM,
    notifier_config: {
      email_configured: smtpReady(),
      telegram_enabled: TELEGRAM_ENABLED,
      telegram_configured: telegramConfigured,
      telegram_chat_id_masked: maskTail(TELEGRAM_CHAT_ID),
      telegram_thread_id: TELEGRAM_THREAD_ID,
    },
    alert_policy: {
      risk_reminder_minutes: RISK_ALERT_REMINDER_MINUTES,
      sends_only_on_risk_or_recovery: true,
      check_green_enabled: RISK_CHECK_GREEN_ENABLED,
      low_sample_grace_minutes: OBSERVABILITY_MIN_REQUESTS_GRACE_MINUTES,
    },
    alert_decision: {
      should_send_risk_alert: shouldSendRiskAlert,
      should_send_recovery_alert: shouldSendRecoveryAlert,
      risk_alert_suppressed: riskAlertSuppressed,
      risk_alert_reason: riskAlertReason,
      previous_risk_active: previousRiskActive,
      previous_last_risk_alert_at_ms: previousLastRiskAlertAtMs || null,
      previous_risk_signature: previousRiskSignature || null,
      current_risk_signature: currentRiskSignature || null,
      cleared_after_minutes: clearedAfterMinutes,
    },
    system_snapshot: systemSnapshot,
    capacity: capacityTelemetry,
    observability: observabilityCheck
      ? {
          requests: observabilityCheck.requests,
          p50_ms: observabilityCheck.p50_ms,
          p95_ms: observabilityCheck.p95_ms,
          p99_ms: observabilityCheck.p99_ms,
          avg_ms: observabilityCheck.avg_ms,
          error_rate_percent: observabilityCheck.error_rate_percent,
          throttled_429_rate_percent: observabilityCheck.throttled_429_rate_percent,
          bootstrap_hit_rate_percent: observabilityCheck.bootstrap_hit_rate_percent,
          bootstrap_notifications_hit_rate_percent:
            observabilityCheck.bootstrap_notifications_hit_rate_percent,
          hotspot_route: observabilityCheck.hotspot_route,
          hotspot_p95_ms: observabilityCheck.hotspot_p95_ms,
        }
      : null,
    observability_by_instance: observabilityByInstance,
    recommended_actions: recommendedActions,
    risk_count: risks.length,
    checks,
    risks,
  };
  console.log(JSON.stringify(summary, null, 2));

  let emailedRisk = false;
  let telegramRisk = false;
  let emailedRecovery = false;
  let telegramRecovery = false;
  let emailedTest = false;
  let telegramTest = false;
  const notifierErrors = [];

  if (risks.length > 0 && shouldSendRiskAlert) {
    const subject = `[RIESGO] Monitor de produccion Minhoo detecto ${risks.length} incidencia(s)`;
    const systemSnapshot = summary.system_snapshot || {};
    const capacity = summary.capacity || {};
    const observability = summary.observability || {};
    const actions = Array.isArray(summary.recommended_actions) ? summary.recommended_actions : [];
    const html = `
      <h2>Alerta de Riesgo en Produccion - Minhoo</h2>
      <p><strong>Fecha/Hora:</strong> ${summary.at}</p>
      <p><strong>Motivo del envio:</strong> ${riskAlertReason}</p>
      <p><strong>Cantidad de riesgos:</strong> ${risks.length}</p>
      <p><strong>Sistema:</strong> cpu=${systemSnapshot.cpu_count || "n/a"} load_5m=${
      systemSnapshot.load_5m ?? "n/a"
    } mem_available_mb=${systemSnapshot.mem_available_mb ?? "n/a"}</p>
      <p><strong>Capacidad:</strong> utilizacion=${capacity.utilization_percent ?? "n/a"}% observed_rps=${
      capacity.observed_rps ?? "n/a"
    } baseline_safe_rps=${capacity.baseline_safe_rps ?? "n/a"}</p>
      <p><strong>Observabilidad:</strong> req=${observability.requests ?? "n/a"} p95_ms=${
      observability.p95_ms ?? "n/a"
    } p99_ms=${observability.p99_ms ?? "n/a"} 5xx=${observability.error_rate_percent ?? "n/a"}% 429=${
      observability.throttled_429_rate_percent ?? "n/a"
    }%</p>
      <ul>${formatRiskRows(risks)}</ul>
      ${actions.length ? `<h3>Acciones Recomendadas</h3><ol>${actions.map((item) => `<li>${item}</li>`).join("")}</ol>` : ""}
      <h3>Checks</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Check</th><th>Resultado</th><th>Status/Estado</th><th>Duracion</th><th>Bytes</th></tr></thead>
        <tbody>${formatCheckRows(checks)}</tbody>
      </table>
    `;
    try {
      await sendEmail({ to: ALERT_EMAIL, subject, html });
      emailedRisk = true;
    } catch (error) {
      notifierErrors.push(`email_risk_fallido: ${String(error?.message || error)}`);
    }
  }

  if (risks.length > 0 && shouldSendRiskAlert && telegramReady) {
    try {
      const text = formatTelegramRiskMessage({ summary, checks, risks, reason: riskAlertReason });
      await sendTelegram({ text });
      telegramRisk = true;
    } catch (error) {
      notifierErrors.push(`telegram_risk_fallido: ${String(error?.message || error)}`);
    }
  }

  if (shouldSendRecoveryAlert) {
    const subject = "[RECUPERADO] Monitor de produccion Minhoo sin riesgos activos";
    const html = `
      <h2>Recuperacion de Produccion - Minhoo</h2>
      <p><strong>Fecha/Hora:</strong> ${summary.at}</p>
      <p><strong>Estado actual:</strong> sin riesgos activos</p>
      <p><strong>Duracion aproximada del incidente:</strong> ${
        Number.isFinite(clearedAfterMinutes) ? `${clearedAfterMinutes} min` : "n/a"
      }</p>
      <p><strong>Ultimo motivo de alerta previa:</strong> ${
        previousAlertState.last_risk_alert_reason || "n/a"
      }</p>
    `;
    try {
      await sendEmail({ to: ALERT_EMAIL, subject, html });
      emailedRecovery = true;
    } catch (error) {
      notifierErrors.push(`email_recovery_fallido: ${String(error?.message || error)}`);
    }
  }

  if (shouldSendRecoveryAlert && telegramReady) {
    try {
      const text = formatTelegramRecoveryMessage({
        summary,
        lastAlertState: previousAlertState,
        clearedAfterMinutes,
      });
      await sendTelegram({ text });
      telegramRecovery = true;
    } catch (error) {
      notifierErrors.push(`telegram_recovery_fallido: ${String(error?.message || error)}`);
    }
  }

  if (SEND_TEST_EMAIL) {
    const subject = "[PRUEBA] Test de entrega de email del monitor Minhoo";
    const html = `
      <h2>Email de Prueba - Monitor Minhoo</h2>
      <p>Este es un email de prueba solicitado luego de correr los checks de produccion.</p>
      <p><strong>Fecha/Hora:</strong> ${summary.at}</p>
      <p><strong>Cantidad de riesgos al momento de la prueba:</strong> ${risks.length}</p>
      <p>Si recibiste este email, la entrega SMTP funciona.</p>
    `;
    try {
      await sendEmail({ to: ALERT_EMAIL, subject, html });
      emailedTest = true;
    } catch (error) {
      notifierErrors.push(`email_test_fallido: ${String(error?.message || error)}`);
    }
  }

  if (SEND_TEST_TELEGRAM) {
    if (!telegramReady) {
      notifierErrors.push(
        "telegram_test_fallido: Telegram deshabilitado o faltan TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID"
      );
    } else {
      try {
        const text = formatTelegramTestMessage({ summary, risks });
        await sendTelegram({ text });
        telegramTest = true;
      } catch (error) {
        notifierErrors.push(`telegram_test_fallido: ${String(error?.message || error)}`);
      }
    }
  }

  const nextAlertState = (() => {
    if (risks.length > 0) {
      const startedAtMs = previousRiskActive && riskStartedAtMs > 0 ? riskStartedAtMs : nowAtEpochMs;
      const lastRiskAlertAtMs = shouldSendRiskAlert
        ? nowAtEpochMs
        : previousLastRiskAlertAtMs || toEpochMs(previousAlertState.last_risk_alert_at_ms) || null;
      return {
        risk_active: true,
        risk_started_at_ms: startedAtMs,
        risk_started_at: new Date(startedAtMs).toISOString(),
        risk_signature: currentRiskSignature || null,
        risk_count: risks.length,
        last_risk_alert_at_ms: lastRiskAlertAtMs,
        last_risk_alert_reason: shouldSendRiskAlert
          ? riskAlertReason
          : String(previousAlertState.last_risk_alert_reason || "suppressed"),
        last_recovered_at_ms: toEpochMs(previousAlertState.last_recovered_at_ms) || null,
        last_recovered_at: String(previousAlertState.last_recovered_at || ""),
      };
    }

    const recoveredAtMs = shouldSendRecoveryAlert
      ? nowAtEpochMs
      : toEpochMs(previousAlertState.last_recovered_at_ms) || null;

    return {
      risk_active: false,
      risk_started_at_ms: null,
      risk_started_at: null,
      risk_signature: null,
      risk_count: 0,
      last_risk_alert_at_ms: previousLastRiskAlertAtMs || null,
      last_risk_alert_reason: String(previousAlertState.last_risk_alert_reason || ""),
      last_recovered_at_ms: recoveredAtMs,
      last_recovered_at: recoveredAtMs ? new Date(recoveredAtMs).toISOString() : null,
    };
  })();
  writeAlertState(nextAlertState);

  console.log(
    JSON.stringify(
      {
        emailed_risk_alert: emailedRisk,
        telegram_risk_alert: telegramRisk,
        emailed_recovery_alert: emailedRecovery,
        telegram_recovery_alert: telegramRecovery,
        risk_alert_suppressed: riskAlertSuppressed,
        risk_alert_reason: riskAlertReason,
        should_send_risk_alert: shouldSendRiskAlert,
        should_send_recovery_alert: shouldSendRecoveryAlert,
        emailed_test: emailedTest,
        telegram_test: telegramTest,
        notifier_errors: notifierErrors,
        risk_count: risks.length,
      },
      null,
      2
    )
  );

  if (notifierErrors.length > 0) {
    for (const errorLine of notifierErrors) {
      console.error(`[notify-error] ${errorLine}`);
    }
  }

  if (risks.length > 0 && shouldSendRiskAlert && !emailedRisk && !telegramRisk) {
    process.exitCode = 3;
    return;
  }

  if (risks.length > 0) {
    process.exitCode = 2;
    return;
  }

  if ((SEND_TEST_EMAIL || SEND_TEST_TELEGRAM) && notifierErrors.length > 0) {
    process.exitCode = 4;
  }
};

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
