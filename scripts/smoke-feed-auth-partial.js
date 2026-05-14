#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

const ROOT_DIR = path.resolve(__dirname, "..");
const ALLOWED_AUTH_STATES = new Set([
  "missing",
  "invalid_token",
  "expired_token",
  "session_miss",
  "backend_unavailable",
  "user_unavailable",
  "verified",
]);

const parseArgs = () => {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const current = String(argv[i] || "");
    if (!current.startsWith("--")) continue;

    const eq = current.indexOf("=");
    if (eq > 2) {
      out[current.slice(2, eq).trim()] = current.slice(eq + 1).trim();
      continue;
    }

    const key = current.slice(2).trim();
    const next = String(argv[i + 1] || "");
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
};

const isTruthy = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const normalizeBaseUrl = (rawValue) => {
  const trimmed = String(rawValue || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "https://api.minhoo.xyz/api/v1";
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
};

const headerValue = (headers, key) => {
  const value = headers?.[String(key || "").toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value ?? "").trim();
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

const request = async ({ url, timeoutMs, token }) => {
  const started = Date.now();
  try {
    const headers = {};
    if (token) headers.authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    const response = await axios.get(url, {
      timeout: timeoutMs,
      headers,
      validateStatus: () => true,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: Number(response.status || 0),
      durationMs: Date.now() - started,
      headers: response.headers || {},
      body: response.data ?? null,
      error: "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - started,
      headers: {},
      body: null,
      error: String(error?.message || error),
    };
  }
};

const readAuthDiagnostics = (headers) => ({
  token: headerValue(headers, "x-auth-optional-token"),
  state: headerValue(headers, "x-auth-optional-state"),
  action: headerValue(headers, "x-auth-action-hint"),
  code: headerValue(headers, "x-auth-error-code"),
});

const readBootstrapDiagnostics = (headers) => ({
  bootstrapCache: headerValue(headers, "x-bootstrap-cache"),
  notificationsCache: headerValue(headers, "x-bootstrap-notifications-cache"),
  partial: headerValue(headers, "x-bootstrap-partial"),
  partialSections: headerValue(headers, "x-bootstrap-partial-sections"),
});

const assertCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const validateAuthHeaders = ({
  label,
  diagnostics,
  expectedToken,
  expectedStates,
}) => {
  assertCondition(
    diagnostics.token === "0" || diagnostics.token === "1",
    `[${label}] invalid X-Auth-Optional-Token: ${diagnostics.token || "<empty>"}`
  );
  assertCondition(
    ALLOWED_AUTH_STATES.has(diagnostics.state),
    `[${label}] invalid X-Auth-Optional-State: ${diagnostics.state || "<empty>"}`
  );
  if (expectedToken !== null) {
    assertCondition(
      diagnostics.token === expectedToken,
      `[${label}] expected token=${expectedToken} got=${diagnostics.token || "<empty>"}`
    );
  }
  if (Array.isArray(expectedStates) && expectedStates.length > 0) {
    assertCondition(
      expectedStates.includes(diagnostics.state),
      `[${label}] expected state in ${expectedStates.join("|")} got=${
        diagnostics.state || "<empty>"
      }`
    );
  }
};

const scenarioProbe = (name) => `${Date.now()}-${name}`;

const runScenario = async ({
  scenarioName,
  baseUrl,
  timeoutMs,
  token,
  expectedToken,
  expectedStates,
  strictAuthVerified,
}) => {
  const probe = scenarioProbe(scenarioName);
  const urls = {
    post: `${baseUrl}/post?summary=1&size=5&page=0&probe=${encodeURIComponent(probe)}`,
    reel: `${baseUrl}/reel?summary=1&size=6&page=0&probe=${encodeURIComponent(probe)}`,
    bootstrap: `${baseUrl}/bootstrap/home?include=posts,reels,services,notifications&posts_size=5&reels_size=6&services_size=4&notifications_limit=5&probe=${encodeURIComponent(
      probe
    )}`,
  };

  const [post, reel, bootstrap] = await Promise.all([
    request({ url: urls.post, timeoutMs, token }),
    request({ url: urls.reel, timeoutMs, token }),
    request({ url: urls.bootstrap, timeoutMs, token }),
  ]);

  assertCondition(post.ok, `[${scenarioName}] /post failed status=${post.status} err=${post.error}`);
  assertCondition(reel.ok, `[${scenarioName}] /reel failed status=${reel.status} err=${reel.error}`);
  assertCondition(
    bootstrap.ok,
    `[${scenarioName}] /bootstrap/home failed status=${bootstrap.status} err=${bootstrap.error}`
  );

  const postAuth = readAuthDiagnostics(post.headers);
  const reelAuth = readAuthDiagnostics(reel.headers);
  const bootstrapAuth = readAuthDiagnostics(bootstrap.headers);
  const bootstrapDiag = readBootstrapDiagnostics(bootstrap.headers);

  validateAuthHeaders({
    label: `${scenarioName}:post`,
    diagnostics: postAuth,
    expectedToken,
    expectedStates,
  });
  validateAuthHeaders({
    label: `${scenarioName}:reel`,
    diagnostics: reelAuth,
    expectedToken,
    expectedStates,
  });
  validateAuthHeaders({
    label: `${scenarioName}:bootstrap`,
    diagnostics: bootstrapAuth,
    expectedToken,
    expectedStates,
  });

  assertCondition(
    bootstrapDiag.partial === "0" || bootstrapDiag.partial === "1",
    `[${scenarioName}:bootstrap] invalid X-Bootstrap-Partial: ${
      bootstrapDiag.partial || "<empty>"
    }`
  );

  if (strictAuthVerified && token) {
    assertCondition(
      postAuth.state === "verified" &&
        reelAuth.state === "verified" &&
        bootstrapAuth.state === "verified",
      `[${scenarioName}] strict mode expected verified state on all routes`
    );
  }

  return {
    scenario: scenarioName,
    post: {
      status: post.status,
      durationMs: post.durationMs,
      auth: postAuth,
      summaryCache: headerValue(post.headers, "x-summary-cache"),
      cfCacheStatus: headerValue(post.headers, "cf-cache-status"),
    },
    reel: {
      status: reel.status,
      durationMs: reel.durationMs,
      auth: reelAuth,
      summaryCache: headerValue(reel.headers, "x-summary-cache"),
      cfCacheStatus: headerValue(reel.headers, "cf-cache-status"),
    },
    bootstrap: {
      status: bootstrap.status,
      durationMs: bootstrap.durationMs,
      auth: bootstrapAuth,
      diagnostics: bootstrapDiag,
    },
  };
};

const main = async () => {
  loadEnv();
  const args = parseArgs();
  const timeoutMs = toPositiveInt(args.timeout || process.env.TEST_TIMEOUT_MS, 20000);
  const baseUrl = normalizeBaseUrl(
    args["base-url"] || process.env.API_BASE_URL || process.env.FEED_SMOKE_API_BASE_URL
  );
  const authToken = String(
    args["auth-token"] ||
      process.env.FEED_SMOKE_AUTH_TOKEN ||
      process.env.AUTH_TOKEN ||
      process.env.TOKEN ||
      ""
  ).trim();
  const strict = isTruthy(args.strict || process.env.FEED_SMOKE_STRICT || "0");
  const asJson = isTruthy(args.json || process.env.FEED_SMOKE_JSON || "0");

  const results = [];

  // Anónimo
  results.push(
    await runScenario({
      scenarioName: "anon",
      baseUrl,
      timeoutMs,
      token: "",
      expectedToken: "0",
      expectedStates: ["missing"],
      strictAuthVerified: false,
    })
  );

  // Token inválido (debe degradar a anónimo pero con diagnóstico explícito)
  results.push(
    await runScenario({
      scenarioName: "invalid",
      baseUrl,
      timeoutMs,
      token: "invalid-token-value",
      expectedToken: "1",
      expectedStates: ["invalid_token", "expired_token"],
      strictAuthVerified: false,
    })
  );

  // Token real opcional
  if (authToken) {
    results.push(
      await runScenario({
        scenarioName: "auth",
        baseUrl,
        timeoutMs,
        token: authToken,
        expectedToken: "1",
        expectedStates: strict
          ? ["verified"]
          : ["verified", "session_miss", "expired_token", "invalid_token"],
        strictAuthVerified: strict,
      })
    );
  } else {
    results.push({
      scenario: "auth",
      skipped: true,
      reason: "No auth token provided (--auth-token / FEED_SMOKE_AUTH_TOKEN).",
    });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          at: new Date().toISOString(),
          base_url: baseUrl,
          strict,
          results,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`[smoke-feed-auth-partial] base=${baseUrl} strict=${strict ? "on" : "off"}`);
  for (const row of results) {
    if (row.skipped) {
      console.log(`- ${row.scenario}: skipped (${row.reason})`);
      continue;
    }
    console.log(`- ${row.scenario}`);
    console.log(
      `  post: status=${row.post.status} state=${row.post.auth.state} token=${row.post.auth.token} action=${row.post.auth.action || "-"} code=${row.post.auth.code || "-"}`
    );
    console.log(
      `  reel: status=${row.reel.status} state=${row.reel.auth.state} token=${row.reel.auth.token} action=${row.reel.auth.action || "-"} code=${row.reel.auth.code || "-"}`
    );
    console.log(
      `  bootstrap: status=${row.bootstrap.status} state=${row.bootstrap.auth.state} token=${row.bootstrap.auth.token} partial=${row.bootstrap.diagnostics.partial} partial_sections=${
        row.bootstrap.diagnostics.partialSections || "-"
      }`
    );
  }
};

main().catch((error) => {
  const message = String(error?.stack || error?.message || error);
  console.error(`[smoke-feed-auth-partial][FAIL] ${message}`);
  process.exit(1);
});

