#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const path = require("path");
const { spawnSync } = require("child_process");
const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const TOKEN_A = String(process.env.TOKEN_A || "").trim();
const TOKEN_B = String(process.env.TOKEN_B || "").trim();
const USER_A_ENV = Number(process.env.USER_A || 0);
const USER_B_ENV = Number(process.env.USER_B || 0);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || "").trim();
const OWNER_PASSWORD_ALT = String(process.env.OWNER_PASSWORD_ALT || "").trim();

const VIEWER_EMAIL = String(process.env.VIEWER_EMAIL || process.env.COMMENTER_EMAIL || "brainstorm.good@gmail.com").trim();
const VIEWER_PASSWORD = String(process.env.VIEWER_PASSWORD || process.env.COMMENTER_PASSWORD || "Eder2010#").trim();
const VIEWER_LOGIN_UUID = String(process.env.VIEWER_LOGIN_UUID || process.env.COMMENTER_LOGIN_UUID || "").trim();
const VIEWER_PASSWORD_ALT = String(process.env.VIEWER_PASSWORD_ALT || "").trim();

const SEND_ITERATIONS = Math.max(1, Math.min(Number(process.env.CHAT_SLO_TEST_SEND_ITERATIONS || 10), 40));
const SUMMARY_ITERATIONS = Math.max(1, Math.min(Number(process.env.CHAT_SLO_TEST_SUMMARY_ITERATIONS || 14), 40));
const SUMMARY_LIMIT = Math.max(1, Math.min(Number(process.env.CHAT_SLO_TEST_SUMMARY_LIMIT || 20), 50));
const LIST_SUMMARY_ITERATIONS = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SLO_TEST_LIST_SUMMARY_ITERATIONS || 12), 40)
);
const LIST_FULL_ITERATIONS = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SLO_TEST_LIST_FULL_ITERATIONS || 12), 40)
);
const EXPECT_MIN_SEND_SAMPLES = Math.max(1, Math.min(Number(process.env.CHAT_SLO_TEST_EXPECT_MIN_SEND || 5), 40));
const EXPECT_MIN_MESSAGE_SUMMARY_SAMPLES = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SLO_TEST_EXPECT_MIN_MSG_SUMMARY || 10), 40)
);
const EXPECT_MIN_LIST_SUMMARY_SAMPLES = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SLO_TEST_EXPECT_MIN_LIST_SUMMARY || 10), 40)
);
const EXPECT_MIN_LIST_FULL_SAMPLES = Math.max(
  1,
  Math.min(Number(process.env.CHAT_SLO_TEST_EXPECT_MIN_LIST_FULL || 10), 40)
);
const SEND_MAX_ATTEMPTS = Math.max(
  SEND_ITERATIONS,
  Math.min(Number(process.env.CHAT_SLO_TEST_SEND_MAX_ATTEMPTS || SEND_ITERATIONS * 4), 200)
);
const SEND_RETRY_WAIT_MS = Math.max(200, Math.min(Number(process.env.CHAT_SLO_TEST_SEND_RETRY_WAIT_MS || 1500), 10000));
const SEND_BETWEEN_WAIT_MS = Math.max(0, Math.min(Number(process.env.CHAT_SLO_TEST_SEND_BETWEEN_WAIT_MS || 120), 2000));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeApi(token = "") {
  const headers = token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : { "Content-Type": "application/json" };

  return axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    headers,
    validateStatus: () => true,
  });
}

function pickToken(loginData) {
  return String(
    loginData?.body?.user?.auth_token ??
      loginData?.body?.auth_token ??
      loginData?.body?.token ??
      loginData?.token ??
      ""
  ).trim();
}

function pickUserId(loginData) {
  const raw =
    loginData?.body?.user?.id ??
    loginData?.body?.id ??
    loginData?.user?.id ??
    0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function decodeUserIdFromJwt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return 0;
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw);
    const candidates = [payload.userId, payload.id, payload.uid, payload.sub];
    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

function resolveUserId(explicitUserId, token) {
  if (Number.isFinite(explicitUserId) && explicitUserId > 0) return explicitUserId;
  return decodeUserIdFromJwt(token);
}

async function login(email, password, uuid) {
  const api = makeApi();
  const payload = { email, password };
  if (String(uuid || "").trim().length >= 20) payload.uuid = String(uuid).trim();

  const response = await api.post("/auth/login", payload);
  assert(
    response.status >= 200 && response.status < 300,
    `Login failed for ${email}. status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const token = pickToken(response.data);
  const userId = pickUserId(response.data);
  assert(looksLikeJwt(token), `Invalid auth token for ${email}`);
  assert(userId > 0, `Invalid user id for ${email}`);
  return { token, userId };
}

function uniquePasswords(candidates) {
  const seen = new Set();
  const out = [];
  for (const value of candidates) {
    const pwd = String(value || "").trim();
    if (!pwd || seen.has(pwd)) continue;
    seen.add(pwd);
    out.push(pwd);
  }
  return out;
}

async function loginWithFallback(email, primaryPassword, altPassword, uuid) {
  const passwords = uniquePasswords([primaryPassword, altPassword, "Eder2010#", "Eder2013#"]);
  let lastError = null;
  for (const password of passwords) {
    try {
      return await login(email, password, uuid);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Login failed for ${email}`);
}

async function resolveRuntimeAuth() {
  const hasTokenA = looksLikeJwt(TOKEN_A);
  const hasTokenB = looksLikeJwt(TOKEN_B);

  if (hasTokenA && hasTokenB) {
    const userA = resolveUserId(USER_A_ENV, TOKEN_A);
    const userB = resolveUserId(USER_B_ENV, TOKEN_B);
    assert(userA > 0, "Missing valid USER_A (env or token payload)");
    assert(userB > 0, "Missing valid USER_B (env or token payload)");
    assert(userA !== userB, "USER_A and USER_B must be different users");
    return {
      owner: { token: TOKEN_A, userId: userA },
      viewer: { token: TOKEN_B, userId: userB },
    };
  }

  const [owner, viewer] = await Promise.all([
    loginWithFallback(OWNER_EMAIL, OWNER_PASSWORD, OWNER_PASSWORD_ALT, OWNER_LOGIN_UUID),
    loginWithFallback(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_PASSWORD_ALT, VIEWER_LOGIN_UUID),
  ]);
  assert(owner.userId !== viewer.userId, "Owner and viewer must be different users");
  return { owner, viewer };
}

async function sendChatTraffic(apiOwner, viewerUserId) {
  let successes = 0;
  let attempts = 0;
  while (successes < SEND_ITERATIONS && attempts < SEND_MAX_ATTEMPTS) {
    attempts += 1;
    const text = `[chat-slo-test] send-${Date.now()}-${attempts}`;
    const response = await apiOwner.post("/chat", { userId: viewerUserId, message: text });
    if (response.status >= 200 && response.status < 300) {
      successes += 1;
      if (SEND_BETWEEN_WAIT_MS > 0) await sleep(SEND_BETWEEN_WAIT_MS);
      continue;
    }

    if (response.status === 429) {
      await sleep(SEND_RETRY_WAIT_MS);
      continue;
    }

    assert(
      false,
      `POST /chat failed at attempt=${attempts}. status=${response.status} body=${JSON.stringify(
        response.data
      )}`
    );
  }
  return { successes, attempts };
}

async function hitMessageSummary(apiOwner, viewerUserId) {
  for (let i = 0; i < SUMMARY_ITERATIONS; i += 1) {
    const response = await apiOwner.get(
      `/chat/message/${viewerUserId}?summary=1&limit=${SUMMARY_LIMIT}&sort=asc`
    );
    assert(
      response.status >= 200 && response.status < 300,
      `GET /chat/message/:id summary failed at i=${i}. status=${response.status} body=${JSON.stringify(response.data)}`
    );
  }
}

async function hitChatList(apiOwner) {
  for (let i = 0; i < LIST_SUMMARY_ITERATIONS; i += 1) {
    const response = await apiOwner.get(`/chat?summary=1&limit=${SUMMARY_LIMIT}`);
    assert(
      response.status >= 200 && response.status < 300,
      `GET /chat summary failed at i=${i}. status=${response.status} body=${JSON.stringify(response.data)}`
    );
  }

  for (let i = 0; i < LIST_FULL_ITERATIONS; i += 1) {
    const response = await apiOwner.get(`/chat?limit=${SUMMARY_LIMIT}`);
    assert(
      response.status >= 200 && response.status < 300,
      `GET /chat full failed at i=${i}. status=${response.status} body=${JSON.stringify(response.data)}`
    );
  }
}

function runChatSloMonitorJson() {
  const monitorScript = path.resolve(__dirname, "monitor-chat-slo.js");
  const child = spawnSync(process.execPath, [monitorScript], {
    env: {
      ...process.env,
      CHAT_SLO_JSON: "1",
      CHAT_SLO_STRICT: "1",
      CHAT_SLO_MIN_ROUTE_SAMPLES: String(
        Math.max(
          EXPECT_MIN_SEND_SAMPLES,
          EXPECT_MIN_MESSAGE_SUMMARY_SAMPLES,
          EXPECT_MIN_LIST_SUMMARY_SAMPLES,
          EXPECT_MIN_LIST_FULL_SAMPLES
        )
      ),
    },
    encoding: "utf8",
  });

  const stdout = String(child.stdout || "").trim();
  const stderr = String(child.stderr || "").trim();

  if (child.status !== 0) {
    throw new Error(
      `monitor-chat-slo exited with status=${child.status}. stdout=${stdout || "<empty>"} stderr=${
        stderr || "<empty>"
      }`
    );
  }

  let payload = null;
  try {
    payload = JSON.parse(stdout);
  } catch (_) {
    throw new Error(`monitor-chat-slo output is not valid JSON: ${stdout || "<empty>"}`);
  }

  return payload;
}

function findRouteCheck(payload, routeKey) {
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  return checks.find((item) => String(item?.route_key || "") === routeKey) || null;
}

async function main() {
  const { owner, viewer } = await resolveRuntimeAuth();

  const apiOwner = makeApi(owner.token);
  const sendStats = await sendChatTraffic(apiOwner, viewer.userId);
  await hitMessageSummary(apiOwner, viewer.userId);
  await hitChatList(apiOwner);

  const monitor = runChatSloMonitorJson();
  assert(monitor?.ok === true, `chat SLO monitor returned ok=false. payload=${JSON.stringify(monitor)}`);

  const sendCheck = findRouteCheck(monitor, "POST:/api/v1/chat:full");
  const msgSummaryCheck = findRouteCheck(monitor, "GET:/api/v1/chat/message/:id:summary");
  const listSummaryCheck = findRouteCheck(monitor, "GET:/api/v1/chat:summary");
  const listFullCheck = findRouteCheck(monitor, "GET:/api/v1/chat:full");

  assert(sendCheck, "Missing POST:/api/v1/chat:full check in chat SLO monitor payload");
  assert(
    Number(sendCheck.count || 0) >= EXPECT_MIN_SEND_SAMPLES,
    `Insufficient POST /chat samples in monitor. count=${sendCheck.count} expected>=${EXPECT_MIN_SEND_SAMPLES}`
  );
  assert(
    String(sendCheck.status || "").toLowerCase() !== "fail",
    `POST /chat check failed: ${sendCheck.reason || "unknown"}`
  );

  assert(
    msgSummaryCheck,
    "Missing GET:/api/v1/chat/message/:id:summary check in chat SLO monitor payload"
  );
  assert(
    Number(msgSummaryCheck.count || 0) >= EXPECT_MIN_MESSAGE_SUMMARY_SAMPLES,
    `Insufficient chat message summary samples in monitor. count=${msgSummaryCheck.count} expected>=${EXPECT_MIN_MESSAGE_SUMMARY_SAMPLES}`
  );
  assert(
    String(msgSummaryCheck.status || "").toLowerCase() !== "fail",
    `chat/message summary check failed: ${msgSummaryCheck.reason || "unknown"}`
  );

  assert(listSummaryCheck, "Missing GET:/api/v1/chat:summary check in chat SLO monitor payload");
  assert(
    Number(listSummaryCheck.count || 0) >= EXPECT_MIN_LIST_SUMMARY_SAMPLES,
    `Insufficient chat list summary samples in monitor. count=${listSummaryCheck.count} expected>=${EXPECT_MIN_LIST_SUMMARY_SAMPLES}`
  );
  assert(
    String(listSummaryCheck.status || "").toLowerCase() !== "fail",
    `chat list summary check failed: ${listSummaryCheck.reason || "unknown"}`
  );

  assert(listFullCheck, "Missing GET:/api/v1/chat:full check in chat SLO monitor payload");
  assert(
    Number(listFullCheck.count || 0) >= EXPECT_MIN_LIST_FULL_SAMPLES,
    `Insufficient chat list full samples in monitor. count=${listFullCheck.count} expected>=${EXPECT_MIN_LIST_FULL_SAMPLES}`
  );
  assert(
    String(listFullCheck.status || "").toLowerCase() !== "fail",
    `chat list full check failed: ${listFullCheck.reason || "unknown"}`
  );

  const warnings = Array.isArray(monitor.warnings) ? monitor.warnings : [];
  const sampleWarnings = warnings.filter((warning) =>
    /POST \/api\/v1\/chat|GET \/api\/v1\/chat|GET \/api\/v1\/chat\/message\/:id|muestras insuficientes/i.test(
      String(warning)
    )
  );
  assert(
    sampleWarnings.length === 0,
    `Monitor still has sample warnings for chat critical routes: ${JSON.stringify(sampleWarnings)}`
  );

  console.log(
    `[pass] chat SLO traffic created send_samples=${sendCheck.count} message_summary_samples=${msgSummaryCheck.count} list_summary_samples=${listSummaryCheck.count} list_full_samples=${listFullCheck.count} send_successes=${sendStats.successes}/${SEND_ITERATIONS} attempts=${sendStats.attempts}`
  );
  console.log("[ok] chat SLO critical route traffic checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
