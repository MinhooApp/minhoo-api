#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const axios = require("axios");
const http = require("http");

const TARGETS = String(
  process.env.SUSTAINED_TARGETS ||
    "http://127.0.0.1:3000/api/v1,http://127.0.0.1:3001/api/v1"
)
  .split(",")
  .map((value) => String(value || "").trim().replace(/\/+$/, ""))
  .filter(Boolean);

const EMAIL = String(process.env.SUSTAINED_EMAIL || "info@minhoo.app").trim();
const PASSWORD = String(process.env.SUSTAINED_PASSWORD || "Eder2010#").trim();
const LOGIN_UUID = String(process.env.SUSTAINED_LOGIN_UUID || "").trim();
const DURATION_SEC = Math.max(60, Number(process.env.SUSTAINED_DURATION_SEC || 1800));
const CONCURRENCY_PER_TARGET = Math.max(
  1,
  Number(process.env.SUSTAINED_CONCURRENCY_PER_TARGET || 25)
);
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.SUSTAINED_TIMEOUT_MS || 12000));
const REPORT_EVERY_SEC = Math.max(10, Number(process.env.SUSTAINED_REPORT_EVERY_SEC || 60));

const WEIGHTS = {
  auth_validate: Number(process.env.SUSTAINED_W_AUTH_VALIDATE || 0.25),
  bootstrap_home: Number(process.env.SUSTAINED_W_BOOTSTRAP_HOME || 0.3),
  notification_list: Number(process.env.SUSTAINED_W_NOTIFICATION_LIST || 0.25),
  chat_list: Number(process.env.SUSTAINED_W_CHAT_LIST || 0.2),
};

const scenarios = [
  {
    name: "auth_validate",
    method: "GET",
    path: "/auth/session/validate",
    auth: true,
    weight: WEIGHTS.auth_validate,
  },
  {
    name: "bootstrap_home",
    method: "GET",
    path: "/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5",
    auth: true,
    weight: WEIGHTS.bootstrap_home,
  },
  {
    name: "notification_list",
    method: "GET",
    path: "/notification?summary=1&limit=20",
    auth: true,
    weight: WEIGHTS.notification_list,
  },
  {
    name: "chat_list",
    method: "GET",
    path: "/chat?summary=1&limit=20",
    auth: true,
    weight: WEIGHTS.chat_list,
  },
].filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);

if (!TARGETS.length) {
  throw new Error("SUSTAINED_TARGETS is empty");
}
if (!scenarios.length) {
  throw new Error("All scenario weights are zero");
}

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;

const pickWeightedScenario = () => {
  const totalWeight = scenarios.reduce((acc, item) => acc + item.weight, 0);
  const random = Math.random() * totalWeight;
  let cursor = 0;
  for (const item of scenarios) {
    cursor += item.weight;
    if (random <= cursor) return item;
  }
  return scenarios[scenarios.length - 1];
};

const makeWorkerIp = (targetIndex, workerId, iteration) => {
  const seed = targetIndex * 200000 + workerId * 1000 + iteration;
  const a = 10 + (targetIndex % 20);
  const b = 1 + ((seed >> 16) % 250);
  const c = 1 + ((seed >> 8) % 250);
  const d = 1 + (seed % 250);
  return `${a}.${b}.${c}.${d}`;
};

const ensureBucket = (stats, key) => {
  if (!stats[key]) {
    stats[key] = {
      total: 0,
      success2xx: 0,
      non2xx: 0,
      statuses: new Map(),
      latencies: [],
    };
  }
  return stats[key];
};

const statusMapToObject = (map) => {
  const output = {};
  for (const [key, value] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    output[String(key)] = value;
  }
  return output;
};

const summarizeLatencies = (latencies) => {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    return {
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      avg: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const len = sorted.length;
  const pick = (p) => {
    const idx = Math.min(len - 1, Math.max(0, Math.ceil((p / 100) * len) - 1));
    return sorted[idx];
  };

  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += sorted[i];

  return {
    p50: Number(pick(50).toFixed(2)),
    p95: Number(pick(95).toFixed(2)),
    p99: Number(pick(99).toFixed(2)),
    max: Number(sorted[len - 1].toFixed(2)),
    avg: Number((sum / len).toFixed(2)),
  };
};

const summarizeBucket = (bucket, elapsedSec) => {
  const safeElapsed = Math.max(0.001, elapsedSec);
  const total = Number(bucket.total || 0);
  const non2xx = Number(bucket.non2xx || 0);
  return {
    total_requests: total,
    rps: Number((total / safeElapsed).toFixed(2)),
    success_2xx: Number(bucket.success2xx || 0),
    non_2xx: non2xx,
    error_rate_pct: Number(((non2xx * 100) / Math.max(1, total)).toFixed(2)),
    latency_ms: summarizeLatencies(bucket.latencies),
    statuses: statusMapToObject(bucket.statuses),
  };
};

const buildHttpClient = (baseURL, maxSockets) =>
  axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    httpAgent: new http.Agent({
      keepAlive: true,
      maxSockets,
    }),
  });

const login = async (baseURL) => {
  const api = buildHttpClient(baseURL, 8);
  const body = { email: EMAIL, password: PASSWORD };
  if (LOGIN_UUID && LOGIN_UUID.length >= 20) body.uuid = LOGIN_UUID;
  const response = await api.post("/auth/login", body);
  const token = String(
    response?.data?.body?.user?.auth_token ||
      response?.data?.body?.auth_token ||
      response?.data?.body?.token ||
      ""
  ).trim();
  if (!(response.status >= 200 && response.status < 300) || !token) {
    throw new Error(
      `login failed baseURL=${baseURL} status=${response.status} body=${JSON.stringify(
        response.data
      )}`
    );
  }
  return token;
};

const run = async () => {
  const startAtMs = Date.now();
  const endAtMs = startAtMs + DURATION_SEC * 1000;

  console.log(
    JSON.stringify(
      {
        phase: "config",
        targets: TARGETS,
        duration_sec: DURATION_SEC,
        concurrency_per_target: CONCURRENCY_PER_TARGET,
        report_every_sec: REPORT_EVERY_SEC,
        weights: WEIGHTS,
      },
      null,
      2
    )
  );

  const targetStateByBaseUrl = new Map();
  for (const target of TARGETS) {
    const token = await login(target);
    targetStateByBaseUrl.set(target, {
      token,
      refreshPromise: null,
    });
  }

  console.log(
    JSON.stringify({
      phase: "auth",
      ok: true,
      targets: TARGETS.length,
    })
  );

  const globalStats = {};
  const intervalStats = {};
  ensureBucket(globalStats, "all");
  ensureBucket(intervalStats, "all");
  for (const scenario of scenarios) {
    ensureBucket(globalStats, scenario.name);
    ensureBucket(intervalStats, scenario.name);
  }

  const refreshTargetToken = async (target) => {
    const state = targetStateByBaseUrl.get(target);
    if (!state) throw new Error(`missing target state for ${target}`);
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        try {
          const token = await login(target);
          state.token = token;
        } finally {
          state.refreshPromise = null;
        }
      })();
    }
    await state.refreshPromise;
    return state.token;
  };

  const workerPromises = [];
  TARGETS.forEach((target, targetIndex) => {
    const targetState = targetStateByBaseUrl.get(target);
    if (!targetState) throw new Error(`missing target state for ${target}`);
    const client = buildHttpClient(target, Math.max(64, CONCURRENCY_PER_TARGET * 4));

    for (let worker = 1; worker <= CONCURRENCY_PER_TARGET; worker += 1) {
      workerPromises.push(
        (async () => {
          let iteration = 0;
          while (Date.now() < endAtMs) {
            const scenario = pickWeightedScenario();
            const headers = {
              "x-forwarded-for": makeWorkerIp(targetIndex + 1, worker, iteration),
            };
            if (scenario.auth && targetState.token) headers.Authorization = `Bearer ${targetState.token}`;

            const started = nowMs();
            let status = 0;
            try {
              let response = await client.request({
                method: scenario.method,
                url: scenario.path,
                headers,
              });
              if (scenario.auth && Number(response.status || 0) === 401) {
                const refreshedToken = await refreshTargetToken(target);
                headers.Authorization = `Bearer ${refreshedToken}`;
                response = await client.request({
                  method: scenario.method,
                  url: scenario.path,
                  headers,
                });
              }
              status = Number(response.status || 0);
            } catch (_error) {
              status = 0;
            }
            const duration = nowMs() - started;
            iteration += 1;

            const buckets = [
              ensureBucket(globalStats, "all"),
              ensureBucket(globalStats, scenario.name),
              ensureBucket(intervalStats, "all"),
              ensureBucket(intervalStats, scenario.name),
            ];

            for (const bucket of buckets) {
              bucket.total += 1;
              bucket.latencies.push(duration);
              bucket.statuses.set(status, (bucket.statuses.get(status) || 0) + 1);
              if (status >= 200 && status < 300) bucket.success2xx += 1;
              else bucket.non2xx += 1;
            }
          }
        })()
      );
    }
  });

  let lastReportAtMs = Date.now();
  const reporter = setInterval(() => {
    const now = Date.now();
    const elapsedSec = (now - lastReportAtMs) / 1000;
    const all = ensureBucket(intervalStats, "all");

    const summary = {
      phase: "interval",
      ts: new Date(now).toISOString(),
      window_sec: Number(elapsedSec.toFixed(2)),
      all: summarizeBucket(all, elapsedSec),
    };
    console.log(JSON.stringify(summary));

    for (const key of Object.keys(intervalStats)) {
      intervalStats[key] = {
        total: 0,
        success2xx: 0,
        non2xx: 0,
        statuses: new Map(),
        latencies: [],
      };
    }
    lastReportAtMs = now;
  }, REPORT_EVERY_SEC * 1000);

  await Promise.all(workerPromises);
  clearInterval(reporter);

  const totalElapsedSec = (Date.now() - startAtMs) / 1000;
  const finalSummary = {
    phase: "final",
    duration_sec: Number(totalElapsedSec.toFixed(2)),
    all: summarizeBucket(ensureBucket(globalStats, "all"), totalElapsedSec),
    scenarios: {},
  };

  for (const scenario of scenarios) {
    finalSummary.scenarios[scenario.name] = summarizeBucket(
      ensureBucket(globalStats, scenario.name),
      totalElapsedSec
    );
  }

  console.log(JSON.stringify(finalSummary, null, 2));
};

run().catch((error) => {
  console.error(
    JSON.stringify({
      phase: "error",
      message: String(error?.message || error),
    })
  );
  process.exit(1);
});
