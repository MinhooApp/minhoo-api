#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
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
  assert(looksLikeJwt(token), `Invalid token for ${email}`);
  return token;
}

function validateReelSummaryShape(reel) {
  assert(reel && typeof reel === "object", "Reel summary item must be object");

  const requiredKeys = [
    "id",
    "description",
    "thumbnail_url",
    "stream_url",
    "video_uid",
    "counts",
    "creator",
    "createdAt",
  ];

  requiredKeys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(reel, key), `Reel summary missing key '${key}'`);
  });

  assert(reel.counts && typeof reel.counts === "object", "Reel summary 'counts' must be object");
  ["likes", "comments", "saves", "views"].forEach((key) => {
    assert(
      Object.prototype.hasOwnProperty.call(reel.counts, key),
      `Reel summary counts missing key '${key}'`
    );
  });

  assert(reel.creator && typeof reel.creator === "object", "Reel summary 'creator' must be object");
  ["id", "username", "avatar", "verified"].forEach((key) => {
    assert(
      Object.prototype.hasOwnProperty.call(reel.creator, key),
      `Reel summary creator missing key '${key}'`
    );
  });
}

async function verifyFeed(api, endpoint, label) {
  const response = await api.get(`${endpoint}?page=0&size=99&summary=1`);
  assert(response.status >= 200 && response.status < 300, `${label} failed status=${response.status}`);

  const body = response.data?.body ?? {};
  const reels = Array.isArray(body.reels) ? body.reels : [];

  assert(Number(body.page) === 0, `${label} expected page=0, got ${body.page}`);
  assert(Number(body.size) === 20, `${label} expected size cap 20, got ${body.size}`);
  assert(reels.length <= 20, `${label} expected <=20 reels, got ${reels.length}`);

  if (reels.length > 0) {
    validateReelSummaryShape(reels[0]);
  }

  return { count: Number(body.count || 0), served: reels.length };
}

async function verifyLoop(api, endpoint, label) {
  const requestedPage = 9999;
  const response = await api.get(
    `${endpoint}?page=${requestedPage}&size=20&summary=1&loop=1`
  );
  assert(response.status >= 200 && response.status < 300, `${label} loop failed status=${response.status}`);

  const body = response.data?.body ?? {};
  const total = Number(body.count || 0);
  const reels = Array.isArray(body.reels) ? body.reels : [];

  assert(Number(body.requestedPage) === requestedPage, `${label} loop expected requestedPage=${requestedPage}`);

  if (total > 0) {
    assert(Boolean(body.looped) === true, `${label} expected looped=true when count>0`);
    assert(reels.length > 0, `${label} expected non-empty reels when count>0`);
  }

  return { total, served: reels.length, looped: Boolean(body.looped) };
}

async function main() {
  const guestApi = makeApi();
  const guestFeed = await verifyFeed(guestApi, "/reel", "guest /reel summary");
  const guestSuggested = await verifyFeed(guestApi, "/reel/suggested", "guest /reel/suggested summary");
  const guestLoop = await verifyLoop(guestApi, "/reel", "guest /reel");
  const guestSuggestedLoop = await verifyLoop(guestApi, "/reel/suggested", "guest /reel/suggested");

  const token = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const authApi = makeApi(token);
  const authFeed = await verifyFeed(authApi, "/reel", "auth /reel summary");
  const authSuggested = await verifyFeed(authApi, "/reel/suggested", "auth /reel/suggested summary");
  const authLoop = await verifyLoop(authApi, "/reel", "auth /reel");
  const authSuggestedLoop = await verifyLoop(authApi, "/reel/suggested", "auth /reel/suggested");

  console.log(
    `[pass] reel summary guest_feed=${guestFeed.served}/${guestFeed.count} guest_suggested=${guestSuggested.served}/${guestSuggested.count} auth_feed=${authFeed.served}/${authFeed.count} auth_suggested=${authSuggested.served}/${authSuggested.count}`
  );
  console.log(
    `[pass] reel loop guest=${guestLoop.looped} guest_suggested=${guestSuggestedLoop.looped} auth=${authLoop.looped} auth_suggested=${authSuggestedLoop.looped}`
  );
  console.log("[ok] step 7 reel summary checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
