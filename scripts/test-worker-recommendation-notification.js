#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);
const EMAIL = String(process.env.EMAIL || "info@minhoo.app").trim();
const PASSWORD = String(process.env.PASSWORD || "Eder2010#").trim();
const LOGIN_UUID = String(process.env.LOGIN_UUID || "").trim();
const PREFIX = "Suggested profile:";
const RECOMMENDATION_TYPES = new Set(["profile_recommendation", "admin"]);
const WINDOW_HOURS = Math.max(
  1,
  Number(process.env.PROFILE_RECOMMENDATION_WINDOW_HOURS || 24) || 24
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pickToken(data) {
  return String(
    data?.body?.user?.auth_token ?? data?.body?.auth_token ?? data?.body?.token ?? data?.token ?? ""
  ).trim();
}

function pickUserId(data) {
  const n = Number(data?.body?.user?.id ?? data?.body?.id ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function makeApi(token = "") {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
  });
}

function toTs(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function filterRecentRecommendations(rows, userId) {
  const since = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : []).filter((n) => {
    const owner = Number(n?.userId);
    const type = String(n?.type ?? "");
    const message = String(n?.message ?? "");
    const ts = toTs(n?.notification_date);
    return (
      owner === userId &&
      RECOMMENDATION_TYPES.has(type) &&
      message.startsWith(PREFIX) &&
      ts >= since
    );
  });
}

async function login() {
  const api = makeApi();
  const payload = { email: EMAIL, password: PASSWORD };
  if (LOGIN_UUID.length >= 20) payload.uuid = LOGIN_UUID;
  const res = await api.post("/auth/login", payload);
  assert(res.status >= 200 && res.status < 300, `login failed status=${res.status}`);
  const token = pickToken(res.data);
  const userId = pickUserId(res.data);
  assert(token, "missing token");
  assert(userId > 0, "missing user id");
  return { token, userId };
}

async function fetchNotifications(api) {
  const res = await api.get("/notification");
  assert(res.status >= 200 && res.status < 300, `GET /notification failed status=${res.status}`);
  return Array.isArray(res.data?.body) ? res.data.body : [];
}

async function hitWorkerFeed(api, suffix) {
  const session = `notif-reco-${Date.now()}-${suffix}`;
  const res = await api.get(`/worker?page=0&size=8&session_key=${session}`);
  assert(res.status >= 200 && res.status < 300, `GET /worker failed status=${res.status}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { token, userId } = await login();
  const api = makeApi(token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);

  const beforeRows = await fetchNotifications(api);
  const beforeReco = filterRecentRecommendations(beforeRows, userId);

  await hitWorkerFeed(api, "a");
  await sleep(600);
  const middleRows = await fetchNotifications(api);
  const middleReco = filterRecentRecommendations(middleRows, userId);

  await hitWorkerFeed(api, "b");
  await sleep(600);
  const afterRows = await fetchNotifications(api);
  const afterReco = filterRecentRecommendations(afterRows, userId);

  const deltaFirst = middleReco.length - beforeReco.length;
  const deltaTotal = afterReco.length - beforeReco.length;
  const deltaSecond = afterReco.length - middleReco.length;

  assert(deltaTotal <= 1, `dedupe failed: expected <=1 new recommendation, got ${deltaTotal}`);
  assert(deltaSecond <= 0, `second call created extra recommendation notification (${deltaSecond})`);

  if (beforeReco.length === 0 && afterReco.length === 0) {
    console.log("[warn] no recommendation notification created (no eligible candidate or feature disabled)");
  } else if (deltaFirst > 0) {
    const latest = afterReco.sort((a, b) => toTs(b.notification_date) - toTs(a.notification_date))[0];
    console.log(
      `[pass] recommendation notification created id=${latest?.id} interactorId=${latest?.interactorId} message=${JSON.stringify(latest?.message)}`
    );
  } else {
    console.log("[pass] recommendation dedupe active (existing notification in window prevented new one)");
  }

  console.log(`[pass] dedupe validated before=${beforeReco.length} middle=${middleReco.length} after=${afterReco.length}`);
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
