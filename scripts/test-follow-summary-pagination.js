#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || "").trim();

const TARGET_USER_ID = (() => {
  const raw = Number(process.env.TARGET_USER_ID || process.env.FOLLOW_TARGET_USER_ID || 26);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 26;
})();

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
  assert(looksLikeJwt(token), `Invalid auth token for ${email}`);
  return token;
}

function getItemsFromBody(body, primaryKey, aliasKey) {
  if (Array.isArray(body?.[primaryKey])) return body[primaryKey];
  if (aliasKey && Array.isArray(body?.[aliasKey])) return body[aliasKey];
  return [];
}

function itemHasMinimumShape(item) {
  if (!item || typeof item !== "object") return false;
  const hasId = item.id !== undefined && item.id !== null;
  const hasUsername = Object.prototype.hasOwnProperty.call(item, "username");
  const hasAvatar = Object.prototype.hasOwnProperty.call(item, "avatar");
  const hasFlags = !!item.flags && typeof item.flags === "object";
  return hasId && hasUsername && hasAvatar && hasFlags;
}

function normalizeIdSet(items) {
  const ids = new Set();
  for (const item of items) {
    const value = Number(item?.id);
    if (Number.isFinite(value) && value > 0) ids.add(Math.trunc(value));
  }
  return ids;
}

async function verifySummaryCursor(api, endpointPath, primaryKey, aliasKey) {
  const first = await api.get(`${endpointPath}?summary=1&limit=20`);
  assert(first.status >= 200 && first.status < 300, `${endpointPath} page 1 failed status=${first.status}`);

  const firstItems = getItemsFromBody(first.data?.body, primaryKey, aliasKey);
  assert(Array.isArray(firstItems), `${endpointPath} must return array in body.${primaryKey}`);
  assert(firstItems.length <= 20, `${endpointPath} page 1 must have at most 20 items`);

  if (firstItems.length > 0) {
    assert(itemHasMinimumShape(firstItems[0]), `${endpointPath} item shape is missing required fields`);
  }

  const bodyNext = Number(first.data?.body?.paging?.next_cursor || 0) || null;
  const headerNext = Number(first.headers?.["x-paging-next-cursor"] || 0) || null;
  const nextCursor = bodyNext || headerNext;

  let secondItems = [];
  if (nextCursor) {
    const second = await api.get(`${endpointPath}?summary=1&limit=20&cursor=${nextCursor}`);
    assert(second.status >= 200 && second.status < 300, `${endpointPath} page 2 failed status=${second.status}`);
    secondItems = getItemsFromBody(second.data?.body, primaryKey, aliasKey);
    assert(secondItems.length <= 20, `${endpointPath} page 2 must have at most 20 items`);

    const firstIds = normalizeIdSet(firstItems);
    const secondIds = normalizeIdSet(secondItems);
    let duplicateCount = 0;
    for (const id of secondIds) {
      if (firstIds.has(id)) duplicateCount += 1;
    }
    assert(duplicateCount === 0, `${endpointPath} page 2 repeated ${duplicateCount} ids from page 1`);
  }

  console.log(
    `[pass] ${endpointPath} summary page1=${firstItems.length} page2=${secondItems.length} next_cursor=${nextCursor || "null"}`
  );
}

async function verifyV2Compatibility(api, endpointPath, primaryKey, aliasKey) {
  const first = await api.get(`${endpointPath}?limit=20`);
  assert(first.status >= 200 && first.status < 300, `${endpointPath} v2 failed status=${first.status}`);

  const items = getItemsFromBody(first.data?.body, primaryKey, aliasKey);
  assert(Array.isArray(items), `${endpointPath} v2 must return array`);

  if (items.length > 0) {
    const item = items[0];
    const hasTopLevelName =
      Object.prototype.hasOwnProperty.call(item, "name") &&
      Object.prototype.hasOwnProperty.call(item, "last_name");
    const hasNestedUserName =
      !!item?.user &&
      typeof item.user === "object" &&
      Object.prototype.hasOwnProperty.call(item.user, "name") &&
      Object.prototype.hasOwnProperty.call(item.user, "last_name");
    assert(
      hasTopLevelName || hasNestedUserName,
      `${endpointPath} v2 item missing name/last_name (top-level or nested user)`
    );
  }

  const paging = first.data?.body?.paging;
  if (paging != null) {
    assert(typeof paging === "object", `${endpointPath} v2 paging must be object when present`);
    assert(
      Object.prototype.hasOwnProperty.call(paging, "next_cursor"),
      `${endpointPath} v2 paging missing next_cursor`
    );
  }

  console.log(`[pass] ${endpointPath} v2 items=${items.length} paging=${paging ? "yes" : "no"}`);
}

async function main() {
  const token = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const api = makeApi(token);

  await verifySummaryCursor(api, `/user/follows/${TARGET_USER_ID}`, "following", "follows");
  await verifySummaryCursor(api, `/user/followers/${TARGET_USER_ID}`, "followers", null);

  await verifyV2Compatibility(api, `/user/${TARGET_USER_ID}/following`, "following", "follows");
  await verifyV2Compatibility(api, `/user/${TARGET_USER_ID}/followers`, "followers", null);

  console.log("[ok] follow/follower summary + v2 compatibility checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
