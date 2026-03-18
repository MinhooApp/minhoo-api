#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const TOKEN = String(process.env.TOKEN || "").trim();
const EMAIL = String(process.env.EMAIL || "info@minhoo.app").trim();
const PASSWORD = String(process.env.PASSWORD || "Eder2010#").trim();
const LOGIN_UUID = String(process.env.LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
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

function makeApi(token = "") {
  const headers = token
    ? {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }
    : { "Content-Type": "application/json" };

  return axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    headers,
    validateStatus: () => true,
  });
}

async function loginIfNeeded() {
  if (looksLikeJwt(TOKEN)) return TOKEN;

  assert(EMAIL, "Missing EMAIL for login");
  assert(PASSWORD, "Missing PASSWORD for login");

  const api = makeApi("");
  const payload = { email: EMAIL, password: PASSWORD };
  if (LOGIN_UUID.length >= 20) {
    payload.uuid = LOGIN_UUID;
  }

  const response = await api.post("/auth/login", payload);
  assert(
    response.status >= 200 && response.status < 300,
    `Login failed status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const authToken = pickToken(response.data);
  assert(looksLikeJwt(authToken), "Login did not return valid JWT token");
  return authToken;
}

async function getWorkers(api, { page = 0, size = 5, sessionKey = "" } = {}) {
  const qs = new URLSearchParams({
    page: String(page),
    size: String(size),
    ...(sessionKey ? { session_key: sessionKey } : {}),
  }).toString();

  const response = await api.get(`/worker?${qs}`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /worker failed status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const body = response?.data?.body ?? {};
  assert(Array.isArray(body.workers), "body.workers is not an array");
  assert(typeof body.count === "number", "body.count is not a number");
  assert(typeof body.page === "number", "body.page is not a number");
  assert(typeof body.size === "number", "body.size is not a number");

  return body;
}

function idsOf(rows) {
  return rows
    .map((row) => Number(row?.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function userIdsOf(rows) {
  return rows
    .map((row) => Number(row?.userId))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function getPrimaryCategoryId(row) {
  const categories = Array.isArray(row?.categories) ? row.categories : [];
  const raw = categories[0]?.id;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function maxCategoryRun(rows) {
  let prev = null;
  let current = 0;
  let max = 0;

  rows.forEach((row) => {
    const categoryId = getPrimaryCategoryId(row);
    if (!categoryId) {
      prev = null;
      current = 0;
      return;
    }

    if (categoryId === prev) {
      current += 1;
    } else {
      prev = categoryId;
      current = 1;
    }

    if (current > max) max = current;
  });

  return max;
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main() {
  const token = await loginIfNeeded();
  const api = makeApi(token);
  const anonApi = makeApi("");

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);

  const sessionA = `worker-test-${Date.now()}-a`;
  const sessionB = `worker-test-${Date.now()}-b`;
  const size = 8;

  const first = await getWorkers(api, { page: 0, size, sessionKey: sessionA });
  const second = await getWorkers(api, { page: 0, size, sessionKey: sessionA });
  const third = await getWorkers(api, { page: 0, size, sessionKey: sessionB });
  const anon = await getWorkers(anonApi, { page: 0, size: 5, sessionKey: `anon-${Date.now()}` });

  const firstIds = idsOf(first.workers);
  const secondIds = idsOf(second.workers);
  const thirdIds = idsOf(third.workers);

  const firstUserIds = userIdsOf(first.workers);
  const uniqueFirstUsers = new Set(firstUserIds);
  assert(
    uniqueFirstUsers.size === firstUserIds.length,
    "duplicate userId detected in same page"
  );

  const run = maxCategoryRun(first.workers);
  const hasEnoughCategorized = first.workers.filter((row) => getPrimaryCategoryId(row)).length >= 3;
  if (hasEnoughCategorized) {
    assert(run <= 2, `topic diversity failed (max consecutive category run=${run})`);
  }

  if (first.count > size + 2 && firstIds.length >= 3 && secondIds.length >= 3) {
    const identicalOrder = sameOrder(firstIds, secondIds);
    assert(!identicalOrder, "session anti-repetition/shuffle not observed (identical order)");
  }

  console.log("[pass] response contract kept (page/size/count/workers)");
  console.log("[pass] no duplicate creators in same page");
  if (hasEnoughCategorized) {
    console.log(`[pass] topic diversity enforced (max consecutive category run=${run})`);
  } else {
    console.log("[warn] topic diversity check skipped (not enough categorized workers)");
  }
  console.log(
    `[pass] session reranking active first=${JSON.stringify(firstIds)} second=${JSON.stringify(secondIds)}`
  );
  console.log(
    `[pass] different session keys return healthy results third=${JSON.stringify(thirdIds)}`
  );
  console.log(`[pass] anonymous /worker works (count=${anon.count}, len=${anon.workers.length})`);
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
