#!/usr/bin/env node
"use strict";

const axios = require("axios");
const http = require("http");
const https = require("https");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim().replace(/\/+$/, "");
const EMAIL = String(process.env.BENCH_EMAIL || "info@minhoo.app").trim();
const PASSWORD = String(process.env.BENCH_PASSWORD || "Eder2010#").trim();
const LOGIN_UUID = String(process.env.BENCH_LOGIN_UUID || "").trim();
const DURATION_SEC = Math.max(8, Number(process.env.BENCH_DURATION_SEC || 15));
const CONCURRENCY_LEVELS = String(process.env.BENCH_CONCURRENCY || "10,25,50")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .map((n) => Math.trunc(n));
const TIMEOUT_MS = Math.max(1000, Number(process.env.BENCH_TIMEOUT_MS || 10000));
const HOST_HEADER = String(process.env.BENCH_HOST_HEADER || "").trim();
const INSECURE_TLS = /^(1|true|yes|on)$/i.test(String(process.env.BENCH_INSECURE_TLS || ""));

const SCENARIO_FILTER = new Set(
  String(process.env.BENCH_SCENARIOS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

const scenariosAll = [
  {
    name: "auth_session_validate",
    method: "GET",
    path: "/auth/session/validate",
    auth: true,
  },
  {
    name: "bootstrap_home",
    method: "GET",
    path: "/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5",
    auth: true,
  },
  {
    name: "chat_list_summary",
    method: "GET",
    path: "/chat?summary=1&limit=20",
    auth: true,
  },
  {
    name: "notification_list",
    method: "GET",
    path: "/notification?limit=20",
    auth: true,
  },
];

const scenarios =
  SCENARIO_FILTER.size > 0
    ? scenariosAll.filter((scenario) => SCENARIO_FILTER.has(scenario.name))
    : scenariosAll;

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function makeWorkerIp(workerId, iteration) {
  const n = workerId * 100000 + iteration;
  const a = 10;
  const b = 1 + ((n >> 16) % 250);
  const c = 1 + ((n >> 8) % 250);
  const d = 1 + (n % 250);
  return `${a}.${b}.${c}.${d}`;
}

async function login() {
  const baseHeaders = {};
  if (HOST_HEADER) baseHeaders.Host = HOST_HEADER;
  const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 16 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: !INSECURE_TLS }),
    headers: baseHeaders,
  });
  const body = { email: EMAIL, password: PASSWORD };
  if (LOGIN_UUID && LOGIN_UUID.length >= 20) body.uuid = LOGIN_UUID;
  const response = await client.post("/auth/login", body);
  const token = String(
    response?.data?.body?.user?.auth_token ||
      response?.data?.body?.auth_token ||
      response?.data?.body?.token ||
      ""
  ).trim();
  if (!(response.status >= 200 && response.status < 300) || !token) {
    throw new Error(`login failed status=${response.status} body=${JSON.stringify(response.data)}`);
  }
  return token;
}

async function runScenario({ scenario, concurrency, durationSec, authToken }) {
  const endAt = Date.now() + durationSec * 1000;
  const started = nowMs();

  const latencies = [];
  const statusCounts = new Map();
  let total = 0;
  let non2xx = 0;

  const client = axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: Math.max(64, concurrency * 4) }),
    httpsAgent: new https.Agent({
      keepAlive: true,
      maxSockets: Math.max(64, concurrency * 4),
      rejectUnauthorized: !INSECURE_TLS,
    }),
  });

  const worker = async (workerId) => {
    let i = 0;
    while (Date.now() < endAt) {
      const headers = {
        "x-forwarded-for": makeWorkerIp(workerId, i),
      };
      if (HOST_HEADER) headers.Host = HOST_HEADER;
      if (scenario.auth && authToken) headers.Authorization = `Bearer ${authToken}`;

      const t0 = nowMs();
      let status = 0;
      try {
        const r = await client.request({
          method: scenario.method,
          url: scenario.path,
          headers,
        });
        status = Number(r.status || 0);
      } catch (_err) {
        status = 0;
      }
      const dt = nowMs() - t0;
      latencies.push(dt);
      total += 1;
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      if (!(status >= 200 && status < 300)) non2xx += 1;
      i += 1;
    }
  };

  const workers = [];
  for (let i = 0; i < concurrency; i += 1) workers.push(worker(i + 1));
  await Promise.all(workers);

  const elapsedSec = Math.max(0.001, (nowMs() - started) / 1000);
  const statusObj = {};
  for (const [k, v] of [...statusCounts.entries()].sort((a, b) => a[0] - b[0])) {
    statusObj[String(k)] = v;
  }

  return {
    scenario: scenario.name,
    concurrency,
    duration_sec: Number(elapsedSec.toFixed(2)),
    total_requests: total,
    rps: Number((total / elapsedSec).toFixed(2)),
    success_2xx: total - non2xx,
    non_2xx: non2xx,
    error_rate_pct: Number(((non2xx * 100) / Math.max(1, total)).toFixed(2)),
    latency_ms: {
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
      max: Number(Math.max(0, ...latencies).toFixed(2)),
      avg: Number((latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)).toFixed(2)),
    },
    statuses: statusObj,
  };
}

(async () => {
  console.log(JSON.stringify({ phase: "config", API_BASE_URL, DURATION_SEC, CONCURRENCY_LEVELS, scenarios: scenarios.map(s => s.name) }, null, 2));

  const token = await login();
  console.log(JSON.stringify({ phase: "auth", login: "ok", token_len: token.length }, null, 2));

  const all = [];
  for (const scenario of scenarios) {
    for (const c of CONCURRENCY_LEVELS) {
      const result = await runScenario({
        scenario,
        concurrency: c,
        durationSec: DURATION_SEC,
        authToken: token,
      });
      all.push(result);
      console.log(JSON.stringify({ phase: "result", ...result }));
    }
  }

  const summary = {};
  for (const scenario of scenarios) {
    const rows = all.filter((r) => r.scenario === scenario.name);
    const stable = rows.filter((r) => r.error_rate_pct <= 1 && r.latency_ms.p95 <= 500);
    const best = stable.sort((a, b) => b.rps - a.rps)[0] || rows.sort((a, b) => b.rps - a.rps)[0];
    summary[scenario.name] = {
      stable_candidate: best
        ? {
            concurrency: best.concurrency,
            rps: best.rps,
            p95: best.latency_ms.p95,
            error_rate_pct: best.error_rate_pct,
          }
        : null,
    };
  }

  console.log(JSON.stringify({ phase: "summary", summary }, null, 2));
})();
