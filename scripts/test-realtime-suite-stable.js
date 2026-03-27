#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
applyFileBackedSecrets(process.env, { forceOverride: false, baseDir: path.resolve(__dirname, "..") });

const ROOT = path.resolve(__dirname, "..");
const argv = new Set(process.argv.slice(2));

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const SOCKET_URL = String(process.env.SOCKET_URL || "http://127.0.0.1:3000").trim();

const TEST_TIMEOUT_MS = Number(process.env.SUITE_TEST_TIMEOUT_MS || 120000);
const COOLDOWN_MS = Number(process.env.SUITE_COOLDOWN_MS || 9000);
const RETRY_COOLDOWN_MS = Number(process.env.SUITE_RETRY_COOLDOWN_MS || 2000);
const PRELOGIN_TOKENS = /^(1|true|yes|on)$/i.test(
  String(process.env.SUITE_PRELOGIN_TOKENS || "0")
);

const OWNER_EMAIL = String(
  process.env.SUITE_OWNER_EMAIL || process.env.OWNER_EMAIL || "info@minhoo.app"
).trim();
const OWNER_PASSWORD = String(
  process.env.SUITE_OWNER_PASSWORD || process.env.OWNER_PASSWORD || "Eder2010#"
).trim();
const OWNER_LOGIN_UUID = String(
  process.env.SUITE_OWNER_LOGIN_UUID ||
    process.env.OWNER_LOGIN_UUID ||
    process.env.LOGIN_UUID ||
    ""
).trim();

const VIEWER_EMAIL = String(
  process.env.SUITE_VIEWER_EMAIL ||
    process.env.VIEWER_EMAIL ||
    process.env.COMMENTER_EMAIL ||
    "brainstorm.good@gmail.com"
).trim();
const VIEWER_PASSWORD = String(
  process.env.SUITE_VIEWER_PASSWORD ||
    process.env.VIEWER_PASSWORD ||
    process.env.COMMENTER_PASSWORD ||
    "Eder2013#"
).trim();
const VIEWER_LOGIN_UUID = String(
  process.env.SUITE_VIEWER_LOGIN_UUID ||
    process.env.VIEWER_LOGIN_UUID ||
    process.env.COMMENTER_LOGIN_UUID ||
    ""
).trim();

const EXTRA_RETRIES = argv.has("--ci") ? 1 : 0;
const BAIL = argv.has("--bail");
const TEST_FILTER = new Set(
  String(process.env.SUITE_TESTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const testsAll = [
  { script: "test:profile:follow-realtime", retries: 0 },
  { script: "test:profile:follow-summary", retries: 0 },
  { script: "test:bootstrap:home", retries: 0 },
  { script: "test:post:summary", retries: 0 },
  { script: "test:reel:summary", retries: 0 },
  { script: "test:profile:orbits-route", retries: 0 },
  { script: "test:orbit:flags", retries: 0 },
  { script: "test:orbit:ring24h", retries: 0 },
  { script: "test:orbit:comment-notification", retries: 0 },
  { script: "test:orbit:comment-realtime", retries: 1 },
  { script: "test:reel:realtime-delete", retries: 0 },
  { script: "test:chat:realtime", retries: 1 },
  { script: "test:chat:message-summary", retries: 0 },
  { script: "test:chat:list-pagination", retries: 0 },
  { script: "test:profile:saved-state", retries: 1 },
  { script: "test:notification:locale", retries: 0 },
  { script: "test:orbit:find:no-consecutive-creator", retries: 0 },
];
const tests =
  TEST_FILTER.size > 0
    ? testsAll.filter((entry) => TEST_FILTER.has(entry.script))
    : testsAll;

function log(message) {
  console.log(`[suite] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function parsePasswordCandidates(primaryPassword, fallbackRaw) {
  const candidates = [
    String(primaryPassword ?? "").trim(),
    ...String(fallbackRaw ?? "")
      .split(",")
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  ].filter(Boolean);

  return Array.from(new Set(candidates));
}

function isInvalidPasswordResponse(response) {
  const status = Number(response?.status ?? 0);
  if (status !== 409 && status !== 401) return false;

  const messages = response?.data?.header?.messages;
  const text = Array.isArray(messages) ? messages.join(" ") : String(messages ?? "");
  return /password|not valid|invalid/i.test(text);
}

async function login(email, passwordCandidates, uuid) {
  assert(email, "Missing email for suite login");
  const candidates = Array.isArray(passwordCandidates)
    ? passwordCandidates.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [String(passwordCandidates ?? "").trim()].filter(Boolean);
  assert(candidates.length > 0, `Missing password for ${email}`);

  let lastResponse = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const password = candidates[index];
    const body = { email, password };
    if (String(uuid || "").trim().length >= 20) {
      body.uuid = String(uuid).trim();
    }

    const response = await axios.post(`${API_BASE_URL}/auth/login`, body, {
      timeout: TEST_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { "Content-Type": "application/json" },
    });
    lastResponse = response;

    if (response.status >= 200 && response.status < 300) {
      const token = pickToken(response.data);
      const userId = pickUserId(response.data);
      assert(looksLikeJwt(token), `Invalid token for ${email}`);
      assert(userId > 0, `Invalid user id for ${email}`);
      return { token, userId, password };
    }

    const canRetry = index < candidates.length - 1 && isInvalidPasswordResponse(response);
    if (!canRetry) break;
  }

  assert(
    false,
    `Login failed ${email}. status=${Number(lastResponse?.status ?? 0)} body=${JSON.stringify(
      lastResponse?.data
    )}`
  );
}

function runScript(script, env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("npm", ["run", script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, TEST_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function buildRuntimeEnv() {
  const runtimeEnv = {
    API_BASE_URL,
    SOCKET_URL,
    OWNER_EMAIL,
    OWNER_PASSWORD,
    OWNER_LOGIN_UUID,
    TARGET_EMAIL: OWNER_EMAIL,
    TARGET_PASSWORD: OWNER_PASSWORD,
    TARGET_LOGIN_UUID: OWNER_LOGIN_UUID,
    EMAIL: OWNER_EMAIL,
    PASSWORD: OWNER_PASSWORD,
    LOGIN_UUID: OWNER_LOGIN_UUID,
    VIEWER_EMAIL,
    VIEWER_PASSWORD,
    VIEWER_LOGIN_UUID,
    COMMENTER_EMAIL: VIEWER_EMAIL,
    COMMENTER_PASSWORD: VIEWER_PASSWORD,
    COMMENTER_LOGIN_UUID: VIEWER_LOGIN_UUID,
  };

  if (!PRELOGIN_TOKENS) return runtimeEnv;

  const ownerPasswordCandidates = parsePasswordCandidates(
    OWNER_PASSWORD,
    process.env.SUITE_OWNER_PASSWORD_FALLBACKS ||
      process.env.OWNER_PASSWORD_FALLBACKS ||
      process.env.SUITE_LOGIN_PASSWORD_FALLBACKS ||
      process.env.LOGIN_PASSWORD_FALLBACKS ||
      ""
  );
  const viewerPasswordCandidates = parsePasswordCandidates(
    VIEWER_PASSWORD,
    process.env.SUITE_VIEWER_PASSWORD_FALLBACKS ||
      process.env.VIEWER_PASSWORD_FALLBACKS ||
      process.env.SUITE_LOGIN_PASSWORD_FALLBACKS ||
      process.env.LOGIN_PASSWORD_FALLBACKS ||
      "Eder2010#,Eder2013#"
  );

  const [owner, viewer] = await Promise.all([
    login(OWNER_EMAIL, ownerPasswordCandidates, OWNER_LOGIN_UUID),
    login(VIEWER_EMAIL, viewerPasswordCandidates, VIEWER_LOGIN_UUID),
  ]);

  assert(owner.userId !== viewer.userId, "Suite owner and viewer must be different users");

  return {
    ...runtimeEnv,
    TOKEN_A: owner.token,
    TOKEN_B: viewer.token,
    USER_A: String(owner.userId),
    USER_B: String(viewer.userId),
    OWNER_TOKEN: owner.token,
    VIEWER_TOKEN: viewer.token,
    OWNER_PASSWORD: owner.password,
    TARGET_PASSWORD: owner.password,
    PASSWORD: owner.password,
    VIEWER_PASSWORD: viewer.password,
    COMMENTER_PASSWORD: viewer.password,
  };
}

async function run() {
  log(`API_BASE_URL=${API_BASE_URL}`);
  log(`SOCKET_URL=${SOCKET_URL}`);
  log(`tests=${tests.length} timeoutMs=${TEST_TIMEOUT_MS} cooldownMs=${COOLDOWN_MS}`);
  log(`owner=${OWNER_EMAIL} viewer=${VIEWER_EMAIL}`);
  log(`prelogin_tokens=${PRELOGIN_TOKENS ? "on" : "off"}`);

  const suiteEnv = await buildRuntimeEnv();
  const results = [];

  for (const test of tests) {
    const maxRetries = Math.max(0, Number(test.retries || 0)) + EXTRA_RETRIES;
    let passed = false;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      log(`run ${test.script} attempt=${attempt}/${maxRetries + 1}`);
      const result = await runScript(test.script, suiteEnv);
      const ok = result.code === 0 && !result.timedOut;

      results.push({
        script: test.script,
        attempt,
        ok,
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });

      if (ok) {
        passed = true;
        log(`pass ${test.script} in ${result.durationMs}ms`);
        break;
      }

      log(
        `fail ${test.script} attempt=${attempt} code=${result.code} timedOut=${result.timedOut} duration=${result.durationMs}ms`
      );

      if (attempt <= maxRetries) {
        log(`retrying ${test.script} after ${RETRY_COOLDOWN_MS}ms`);
        await sleep(RETRY_COOLDOWN_MS);
      }
    }

    if (!passed && BAIL) {
      log(`bail enabled, stopping after ${test.script}`);
      break;
    }

    await sleep(COOLDOWN_MS);
  }

  const finalByScript = new Map();
  for (const row of results) {
    finalByScript.set(row.script, row);
  }

  const failed = [...finalByScript.values()].filter((row) => !row.ok);
  const passed = [...finalByScript.values()].filter((row) => row.ok);

  log("summary");
  for (const row of [...finalByScript.values()]) {
    log(
      `${row.ok ? "PASS" : "FAIL"} ${row.script} attempt=${row.attempt} duration=${row.durationMs}ms`
    );
  }
  log(`totals pass=${passed.length} fail=${failed.length} attempts=${results.length}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(`[suite] fatal ${error?.message || error}`);
  process.exit(1);
});
