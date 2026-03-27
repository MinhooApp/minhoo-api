#!/usr/bin/env node

/* eslint-disable no-console */
const axios = require("axios");
const nodemailer = require("nodemailer");
const path = require("path");
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
  const currentRequests = toFiniteNumber(stubStatus?.requests_total, null);
  let observed_rps = null;
  let sample_seconds = null;
  let requests_delta = null;
  let utilization_percent = null;

  if (
    previous &&
    Number.isFinite(toFiniteNumber(previous.ts_ms, null)) &&
    Number.isFinite(toFiniteNumber(previous.requests_total, null)) &&
    Number.isFinite(currentRequests)
  ) {
    sample_seconds = (nowAtMs - Number(previous.ts_ms)) / 1000;
    requests_delta = Number(currentRequests) - Number(previous.requests_total);
    if (sample_seconds >= 10 && requests_delta >= 0) {
      observed_rps = round2(requests_delta / sample_seconds);
      utilization_percent = round2((observed_rps / BASELINE_SAFE_RPS) * 100);
    }
  }

  if (Number.isFinite(currentRequests)) {
    writeMonitorState({
      ts_ms: nowAtMs,
      requests_total: Number(currentRequests),
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
      return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FALLA"}</td><td>${check.status}</td><td>${check.duration_ms} ms</td><td>${check.bytes}</td></tr>`;
    })
    .join("");
};
const formatTelegramRiskMessage = ({ summary, checks, risks }) => {
  const failedChecks = checks.filter((check) => !check.ok);
  const slowChecks = checks.filter((check) => check.type === "http" && check.ok && check.slow);
  const actions = Array.isArray(summary?.recommended_actions) ? summary.recommended_actions : [];
  const capacity = summary?.capacity || {};
  const lines = [];
  lines.push("<b>Alerta de Riesgo en Produccion - Minhoo</b>");
  lines.push(`Hora: <code>${escapeHtml(summary.at)}</code>`);
  lines.push(`Cantidad de riesgos: <b>${risks.length}</b>`);
  lines.push(`Checks fallidos: <b>${failedChecks.length}</b>`);
  lines.push(`Checks lentos: <b>${slowChecks.length}</b>`);
  if (Number.isFinite(capacity?.utilization_percent)) {
    lines.push(
      `Capacidad: <b>${escapeHtml(capacity.utilization_percent)}%</b> (${escapeHtml(
        capacity.observed_rps
      )} rps / base segura ${escapeHtml(capacity.baseline_safe_rps)} rps)`
    );
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
    await probeHttp({
      name: "blue_ping",
      url: "http://127.0.0.1:3000/api/v1/ping",
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
      url: `http://127.0.0.1:3000${SMOKE_BOOTSTRAP_PATH}`,
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
      url: "http://127.0.0.1:3000/api/v1/catalog/countries",
      expected: [200],
      warnMs: 900,
    })
  );
  checks.push(
    await probeHttp({
      name: "blue_internal_summary_routes",
      url: "http://127.0.0.1:3000/api/v1/internal/debug/summary-routes",
      headers: internalHeaders,
      expected: [200],
      warnMs: 1000,
    })
  );
  checks.push(
    await probeHttp({
      name: "blue_internal_perf_check",
      url: "http://127.0.0.1:3000/api/v1/internal/perf-check",
      headers: internalHeaders,
      expected: [200],
      timeout: 30000,
      warnMs: 2500,
    })
  );
  const risks = [];
  for (const check of checks) {
    if (!check.ok) {
      if (check.type === "service") {
        risks.push(`[ALTA] Servicio caido o desconocido: ${check.service} (estado=${check.state})`);
        addAction(`Reiniciar y validar ${check.service} inmediatamente.`);
      } else {
        risks.push(
          `[ALTA] Check HTTP fallido: ${check.name} status=${check.status} duration_ms=${check.duration_ms} url=${check.url}`
        );
        addAction("Validar salud de upstream y revertir cambios recientes si aplica.");
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
    system_snapshot: systemSnapshot,
    capacity: capacityTelemetry,
    recommended_actions: recommendedActions,
    risk_count: risks.length,
    checks,
    risks,
  };
  console.log(JSON.stringify(summary, null, 2));

  let emailedRisk = false;
  let telegramRisk = false;
  let emailedTest = false;
  let telegramTest = false;
  const notifierErrors = [];

  if (risks.length > 0) {
    const subject = `[RIESGO] Monitor de produccion Minhoo detecto ${risks.length} incidencia(s)`;
    const systemSnapshot = summary.system_snapshot || {};
    const capacity = summary.capacity || {};
    const actions = Array.isArray(summary.recommended_actions) ? summary.recommended_actions : [];
    const html = `
      <h2>Alerta de Riesgo en Produccion - Minhoo</h2>
      <p><strong>Fecha/Hora:</strong> ${summary.at}</p>
      <p><strong>Cantidad de riesgos:</strong> ${risks.length}</p>
      <p><strong>Sistema:</strong> cpu=${systemSnapshot.cpu_count || "n/a"} load_5m=${
      systemSnapshot.load_5m ?? "n/a"
    } mem_available_mb=${systemSnapshot.mem_available_mb ?? "n/a"}</p>
      <p><strong>Capacidad:</strong> utilizacion=${capacity.utilization_percent ?? "n/a"}% observed_rps=${
      capacity.observed_rps ?? "n/a"
    } baseline_safe_rps=${capacity.baseline_safe_rps ?? "n/a"}</p>
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

  if (risks.length > 0 && telegramReady) {
    try {
      const text = formatTelegramRiskMessage({ summary, checks, risks });
      await sendTelegram({ text });
      telegramRisk = true;
    } catch (error) {
      notifierErrors.push(`telegram_risk_fallido: ${String(error?.message || error)}`);
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

  console.log(
    JSON.stringify(
      {
        emailed_risk_alert: emailedRisk,
        telegram_risk_alert: telegramRisk,
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

  if (risks.length > 0 && !emailedRisk && !telegramRisk) {
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
