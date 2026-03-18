#!/usr/bin/env node

/* eslint-disable no-console */
const axios = require("axios");
const nodemailer = require("nodemailer");
require("dotenv").config();
const { execSync } = require("child_process");

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (flag) => {
  const idx = argv.indexOf(flag);
  if (idx < 0) return "";
  return String(argv[idx + 1] ?? "").trim();
};

const SEND_TEST_EMAIL = hasFlag("--send-test-email");
const ALERT_EMAIL = getArgValue("--email") || process.env.RISK_ALERT_EMAIL || "info@minhoo.app";
const INTERNAL_DEBUG_TOKEN = String(process.env.INTERNAL_DEBUG_TOKEN || "").trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "https://api.minhoo.xyz").replace(/\/+$/, "");
const SMOKE_BOOTSTRAP_PATH =
  "/api/v1/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5";

const nowIso = () => new Date().toISOString();
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const toByteLength = (value) => {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value));
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
    throw new Error("SMTP env is incomplete (EMAIL_HOST/PORT/USER/PASS)");
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
  if (!risks.length) return "<li>No risks detected.</li>";
  return risks.map((risk) => `<li>${risk}</li>`).join("");
};

const formatCheckRows = (checks) => {
  return checks
    .map((check) => {
      if (check.type === "service") {
        return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FAIL"}</td><td>${check.state}</td><td>-</td><td>-</td></tr>`;
      }
      return `<tr><td>${check.name}</td><td>${check.ok ? "OK" : "FAIL"}</td><td>${check.status}</td><td>${check.duration_ms} ms</td><td>${check.bytes}</td></tr>`;
    })
    .join("");
};

const main = async () => {
  const checks = [];

  const internalHeaders = { "x-internal-debug": "true" };
  if (INTERNAL_DEBUG_TOKEN) internalHeaders["x-internal-debug-token"] = INTERNAL_DEBUG_TOKEN;

  checks.push(probeServiceActive("minhoo-api.service"));
  checks.push(probeServiceActive("minhoo-api-green.service"));
  checks.push(probeServiceActive("nginx.service"));
  checks.push(probeServiceActive("mysql.service"));

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
      name: "green_ping",
      url: "http://127.0.0.1:3001/api/v1/ping",
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
      name: "green_bootstrap",
      url: `http://127.0.0.1:3001${SMOKE_BOOTSTRAP_PATH}`,
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
      name: "green_catalog_countries",
      url: "http://127.0.0.1:3001/api/v1/catalog/countries",
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
      name: "green_internal_summary_routes",
      url: "http://127.0.0.1:3001/api/v1/internal/debug/summary-routes",
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
  checks.push(
    await probeHttp({
      name: "green_internal_perf_check",
      url: "http://127.0.0.1:3001/api/v1/internal/perf-check",
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
        risks.push(`[HIGH] Service down or unknown: ${check.service} (state=${check.state})`);
      } else {
        risks.push(
          `[HIGH] HTTP check failed: ${check.name} status=${check.status} duration_ms=${check.duration_ms} url=${check.url}`
        );
      }
      continue;
    }
    if (check.type === "http" && check.slow) {
      risks.push(
        `[MEDIUM] Slow endpoint: ${check.name} duration_ms=${check.duration_ms} threshold_ms=${check.warn_ms}`
      );
    }
  }

  if (!INTERNAL_DEBUG_TOKEN) {
    risks.push(
      "[LOW] INTERNAL_DEBUG_TOKEN is empty in current environment; internal debug checks may fail."
    );
  }

  const summary = {
    at: nowIso(),
    alert_email: ALERT_EMAIL,
    send_test_email: SEND_TEST_EMAIL,
    risk_count: risks.length,
    checks,
    risks,
  };
  console.log(JSON.stringify(summary, null, 2));

  let emailedRisk = false;
  let emailedTest = false;

  if (risks.length > 0) {
    const subject = `[RISK] Minhoo production monitor detected ${risks.length} issue(s)`;
    const html = `
      <h2>Minhoo Production Risk Alert</h2>
      <p><strong>Timestamp:</strong> ${summary.at}</p>
      <p><strong>Risk count:</strong> ${risks.length}</p>
      <ul>${formatRiskRows(risks)}</ul>
      <h3>Checks</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Check</th><th>Result</th><th>Status/State</th><th>Duration</th><th>Bytes</th></tr></thead>
        <tbody>${formatCheckRows(checks)}</tbody>
      </table>
    `;
    await sendEmail({ to: ALERT_EMAIL, subject, html });
    emailedRisk = true;
  }

  if (SEND_TEST_EMAIL) {
    const subject = "[TEST] Minhoo monitor email delivery test";
    const html = `
      <h2>Minhoo Monitor Test Email</h2>
      <p>This is a test email requested after running production checks.</p>
      <p><strong>Timestamp:</strong> ${summary.at}</p>
      <p><strong>Risk count at test time:</strong> ${risks.length}</p>
      <p>If you received this email, SMTP delivery is working.</p>
    `;
    await sendEmail({ to: ALERT_EMAIL, subject, html });
    emailedTest = true;
  }

  console.log(
    JSON.stringify(
      {
        emailed_risk_alert: emailedRisk,
        emailed_test: emailedTest,
        risk_count: risks.length,
      },
      null,
      2
    )
  );

  if (risks.length > 0) {
    process.exitCode = 2;
  }
};

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
