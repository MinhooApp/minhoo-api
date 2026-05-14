#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const REQUEST_TIMEOUT_MS = Number(process.env.NETWORK_TEST_TIMEOUT_MS || 15000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.NETWORK_TEST_MAX_ATTEMPTS || 4));
const BASE_BACKOFF_MS = Math.max(50, Number(process.env.NETWORK_TEST_BACKOFF_MS || 300));
const API_ORIGIN = (() => {
  try {
    return new URL(API_BASE_URL).origin;
  } catch {
    return "http://127.0.0.1:3000";
  }
})();

const SYNTHETIC_3G_LATENCY_MS = Math.max(
  0,
  Number(process.env.NETWORK_TEST_3G_LATENCY_MS || 350)
);
const SYNTHETIC_3G_JITTER_MS = Math.max(
  0,
  Number(process.env.NETWORK_TEST_3G_JITTER_MS || 250)
);
const SYNTHETIC_PACKET_LOSS_PCT = Math.max(
  0,
  Math.min(0.6, Number(process.env.NETWORK_TEST_PACKET_LOSS_PCT || 0.12))
);

const VIEWER_EMAIL = String(
  process.env.NETWORK_TEST_VIEWER_EMAIL || process.env.SUITE_VIEWER_EMAIL || ""
).trim();
const VIEWER_PASSWORD = String(
  process.env.NETWORK_TEST_VIEWER_PASSWORD || process.env.SUITE_VIEWER_PASSWORD || ""
).trim();
const VIEWER_LOGIN_UUID = String(
  process.env.NETWORK_TEST_VIEWER_UUID || process.env.SUITE_VIEWER_LOGIN_UUID || ""
).trim();
const NETWORK_TEST_AUTH_TOKEN = String(process.env.NETWORK_TEST_AUTH_TOKEN || "").trim();
const NETWORK_TEST_REFRESH_TOKEN = String(process.env.NETWORK_TEST_REFRESH_TOKEN || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function randomLatencyMs() {
  if (SYNTHETIC_3G_JITTER_MS <= 0) return SYNTHETIC_3G_LATENCY_MS;
  const jitter = Math.floor(Math.random() * (SYNTHETIC_3G_JITTER_MS + 1));
  return SYNTHETIC_3G_LATENCY_MS + jitter;
}

function simulatePacketLoss() {
  return Math.random() < SYNTHETIC_PACKET_LOSS_PCT;
}

function normalizeBearer(rawToken) {
  const value = String(rawToken || "").trim();
  if (!value) return "";
  return value.toLowerCase().startsWith("bearer ") ? value : `Bearer ${value}`;
}

function looksLikeJwt(token) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function makeApi(authToken = "") {
  const headers = {
    "Content-Type": "application/json",
    "x-network-profile": "synthetic-3g",
    "x-network-test": "1",
  };
  if (authToken) {
    headers.Authorization = normalizeBearer(authToken);
  }
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: REQUEST_TIMEOUT_MS,
    headers,
    validateStatus: () => true,
    maxRedirects: 5,
  });
}

function pickAccessToken(payload) {
  return String(
    payload?.body?.user?.auth_token ||
      payload?.body?.user?.authToken ||
      payload?.body?.user?.access_token ||
      payload?.body?.user?.accessToken ||
      payload?.body?.auth_token ||
      payload?.body?.authToken ||
      payload?.body?.access_token ||
      payload?.body?.accessToken ||
      payload?.body?.token ||
      payload?.token ||
      ""
  ).trim();
}

function pickRefreshToken(payload) {
  return String(
    payload?.body?.user?.refresh_token ||
      payload?.body?.user?.refreshToken ||
      payload?.body?.refresh_token ||
      payload?.body?.refreshToken ||
      payload?.refresh_token ||
      payload?.refreshToken ||
      ""
  ).trim();
}

function parseErrorCode(response) {
  return String(
    response?.headers?.["x-auth-error-code"] ||
      response?.data?.code ||
      response?.data?.error_code ||
      ""
  ).trim();
}

function isRetriableStatus(status) {
  const code = Number(status || 0);
  return code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599);
}

function isRetriableError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (!code) return false;
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  );
}

async function requestWithSyntheticNetwork(api, requestConfig, label) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await sleep(randomLatencyMs());

    if (simulatePacketLoss()) {
      lastError = new Error(`[${label}] synthetic packet loss (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
      throw lastError;
    }

    try {
      const response = await api.request(requestConfig);
      const status = Number(response?.status || 0);
      if (status >= 200 && status < 300) return response;

      if (isRetriableStatus(status) && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }

      const authCode = parseErrorCode(response);
      const body = JSON.stringify(response?.data || {});
      throw new Error(
        `[${label}] status=${status} auth_code=${authCode || "<none>"} body=${body}`
      );
    } catch (error) {
      lastError = error;
      if (isRetriableError(error) && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error(`[${label}] request failed`);
}

function firstPostMediaPath(post) {
  const mediaRows = Array.isArray(post?.post_media) ? post.post_media : [];
  const first = mediaRows.find((row) => String(row?.url || "").trim().length > 0);
  return String(first?.url || "").trim();
}

function resolveMediaUrl(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;

  let path = value.startsWith("/") ? value : `/${value}`;
  if (path.startsWith("/api/v1/")) return `${API_ORIGIN}${path}`;
  if (path.startsWith("/media/")) return `${API_ORIGIN}/api/v1${path}`;
  return `${API_ORIGIN}${path}`;
}

async function main() {
  const startedAt = Date.now();
  const steps = [];

  const guestApi = makeApi();
  let accessToken = NETWORK_TEST_AUTH_TOKEN;
  let refreshToken = NETWORK_TEST_REFRESH_TOKEN;

  if (!accessToken) {
    assert(VIEWER_EMAIL, "Missing NETWORK_TEST_VIEWER_EMAIL or SUITE_VIEWER_EMAIL");
    assert(VIEWER_PASSWORD, "Missing NETWORK_TEST_VIEWER_PASSWORD or SUITE_VIEWER_PASSWORD");

    const loginPayload = {
      email: VIEWER_EMAIL,
      password: VIEWER_PASSWORD,
    };
    if (VIEWER_LOGIN_UUID) loginPayload.uuid = VIEWER_LOGIN_UUID;

    const loginRes = await requestWithSyntheticNetwork(
      guestApi,
      { method: "POST", url: "/auth/login", data: loginPayload },
      "auth.login"
    );
    accessToken = pickAccessToken(loginRes.data);
    refreshToken = pickRefreshToken(loginRes.data);
    assert(looksLikeJwt(accessToken), "auth.login did not return valid access token");
    assert(looksLikeJwt(refreshToken), "auth.login did not return valid refresh token");
    steps.push({ step: "auth.login", status: loginRes.status });
  } else {
    assert(looksLikeJwt(accessToken), "NETWORK_TEST_AUTH_TOKEN is not a valid JWT");
    steps.push({ step: "auth.login", status: "skipped_token_override" });
  }

  const authApi = makeApi(accessToken);
  const validateRes = await requestWithSyntheticNetwork(
    authApi,
    { method: "GET", url: "/auth/session/validate" },
    "auth.session.validate"
  );
  steps.push({ step: "auth.session.validate", status: validateRes.status });

  let refreshedAccessToken = accessToken;
  if (refreshToken) {
    const refreshRes = await requestWithSyntheticNetwork(
      guestApi,
      {
        method: "POST",
        url: "/auth/refresh",
        data: {
          refresh_token: refreshToken,
          uuid: VIEWER_LOGIN_UUID || `net3g-${Date.now()}`,
        },
      },
      "auth.refresh"
    );
    refreshedAccessToken = pickAccessToken(refreshRes.data) || accessToken;
    assert(looksLikeJwt(refreshedAccessToken), "auth.refresh did not return valid access token");
    steps.push({ step: "auth.refresh", status: refreshRes.status });
  } else {
    steps.push({ step: "auth.refresh", status: "skipped_missing_refresh_token" });
  }

  // Simulate app reopen with fresh token.
  const reopenedApi = makeApi(refreshedAccessToken);

  const bootstrapRes = await requestWithSyntheticNetwork(
    reopenedApi,
    {
      method: "GET",
      url: "/bootstrap/home",
      params: { include: "posts,reels,services,notifications" },
    },
    "bootstrap.home"
  );
  steps.push({ step: "bootstrap.home", status: bootstrapRes.status });

  const feedRes = await requestWithSyntheticNetwork(
    reopenedApi,
    { method: "GET", url: "/post", params: { page: 0, size: 10 } },
    "post.feed"
  );
  const feedPosts = Array.isArray(feedRes?.data?.body?.posts) ? feedRes.data.body.posts : [];
  assert(feedPosts.length > 0, "post.feed returned no posts");
  steps.push({ step: "post.feed", status: feedRes.status, posts: feedPosts.length });

  const mediaPath = feedPosts.map(firstPostMediaPath).find((url) => url.startsWith("/api/v1/media/"));
  if (mediaPath) {
    const mediaUrl = resolveMediaUrl(mediaPath);
    const mediaRes = await requestWithSyntheticNetwork(
      reopenedApi,
      {
        method: "GET",
        url: mediaUrl,
      },
      "media.playback"
    );
    steps.push({ step: "media.playback", status: mediaRes.status, url: mediaUrl });
  } else {
    steps.push({ step: "media.playback", status: "skipped_no_media" });
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    JSON.stringify(
      {
        ok: true,
        profile: {
          latency_ms: SYNTHETIC_3G_LATENCY_MS,
          jitter_ms: SYNTHETIC_3G_JITTER_MS,
          packet_loss_pct: Math.round(SYNTHETIC_PACKET_LOSS_PCT * 10000) / 100,
          max_attempts: MAX_ATTEMPTS,
        },
        duration_ms: durationMs,
        steps,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = String(error?.stack || error?.message || error);
  console.error(`[network-3g-test][FAIL] ${message}`);
  process.exit(1);
});
