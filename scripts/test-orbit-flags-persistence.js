#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const TOKEN = String(process.env.TOKEN || "").trim();
const EMAIL = String(process.env.EMAIL || "").trim();
const PASSWORD = String(process.env.PASSWORD || "").trim();
const LOGIN_UUID = String(process.env.LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function buildApi(token) {
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

function getAuthToken(data) {
  return String(
    data?.body?.user?.auth_token ??
      data?.body?.auth_token ??
      data?.body?.token ??
      data?.token ??
      ""
  ).trim();
}

async function loginIfNeeded() {
  if (looksLikeJwt(TOKEN)) return TOKEN;
  assert(EMAIL, "Missing EMAIL for login");
  assert(PASSWORD, "Missing PASSWORD for login");

  const api = buildApi("");
  const body = {
    email: EMAIL,
    password: PASSWORD,
  };
  if (LOGIN_UUID.length >= 20) {
    body.uuid = LOGIN_UUID;
  }
  const response = await api.post("/auth/login", body);

  assert(
    response.status >= 200 && response.status < 300,
    `Login failed status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const token = getAuthToken(response.data);
  assert(looksLikeJwt(token), "Login did not return a valid JWT token");
  return token;
}

function boolFlag(entity, snake, camel) {
  if (!entity) return false;
  if (typeof entity[camel] === "boolean") return entity[camel];
  if (typeof entity[snake] === "boolean") return entity[snake];
  return Boolean(entity[camel] ?? entity[snake]);
}

async function getSuggested(api) {
  const response = await api.get("/reel/suggested?page=0&size=30");
  assert(
    response.status >= 200 && response.status < 300,
    `GET /reel/suggested failed status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  const reels = response?.data?.body?.reels;
  assert(Array.isArray(reels), "reels is not an array in /reel/suggested");
  return reels;
}

async function getById(api, reelId) {
  const response = await api.get(`/reel/${reelId}`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /reel/${reelId} failed status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  return response?.data?.body?.reel;
}

async function toggleStar(api, reelId) {
  const response = await api.put(`/reel/star/${reelId}`, {});
  assert(
    response.status >= 200 && response.status < 300,
    `PUT /reel/star/${reelId} failed status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  return response.data?.body;
}

async function save(api, reelId) {
  const response = await api.post(`/reel/${reelId}/save`, {});
  assert(
    response.status >= 200 && response.status < 300,
    `POST /reel/${reelId}/save failed status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  return response.data?.body;
}

async function unsave(api, reelId) {
  const response = await api.delete(`/reel/${reelId}/save`);
  assert(
    response.status >= 200 && response.status < 300,
    `DELETE /reel/${reelId}/save failed status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  return response.data?.body;
}

async function main() {
  const token = await loginIfNeeded();
  const api = buildApi(token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);

  const suggested = await getSuggested(api);
  assert(suggested.length > 0, "No reels available in suggested feed for test");

  const target = suggested[0];
  const reelId = Number(target?.id || 0);
  assert(Number.isFinite(reelId) && reelId > 0, "Invalid reel id in suggested feed");
  console.log(`[test] target reelId=${reelId}`);

  // Baseline cleanup
  await unsave(api, reelId);
  const baselineStarBody = await toggleStar(api, reelId);
  if (baselineStarBody?.starred === true || baselineStarBody?.liked === true) {
    await toggleStar(api, reelId);
  }

  // Set starred + saved
  const starBody = await toggleStar(api, reelId);
  assert(
    starBody?.starred === true || starBody?.liked === true,
    "Expected starred=true after toggle star"
  );
  const saveBody = await save(api, reelId);
  assert(saveBody?.saved === true, "Expected saved=true after save");

  // Verify in detail payload
  const reelById = await getById(api, reelId);
  const byIdStarSnake = boolFlag(reelById, "is_starred", "isStarred");
  const byIdSaveSnake = boolFlag(reelById, "is_saved", "isSaved");
  assert(byIdStarSnake === true, "GET /reel/:id did not keep star=true");
  assert(byIdSaveSnake === true, "GET /reel/:id did not keep saved=true");
  assert(typeof reelById?.isStarred === "boolean", "Missing camelCase isStarred");
  assert(typeof reelById?.isSaved === "boolean", "Missing camelCase isSaved");
  console.log("[pass] detail payload keeps star/save flags and camelCase aliases");

  // Verify in feed payload (simulates UI reload)
  const suggestedReload = await getSuggested(api);
  const fromFeed = suggestedReload.find((item) => Number(item?.id) === reelId);
  assert(fromFeed, "Reel not found in feed after reload");
  const feedStar = boolFlag(fromFeed, "is_starred", "isStarred");
  const feedSave = boolFlag(fromFeed, "is_saved", "isSaved");
  assert(feedStar === true, "Feed reload lost star=true");
  assert(feedSave === true, "Feed reload lost saved=true");
  assert(typeof fromFeed?.isStarred === "boolean", "Feed missing camelCase isStarred");
  assert(typeof fromFeed?.isSaved === "boolean", "Feed missing camelCase isSaved");
  console.log("[pass] feed reload keeps star/save flags and camelCase aliases");

  // Cleanup
  await unsave(api, reelId);
  const cleanupStarBody = await toggleStar(api, reelId);
  if (cleanupStarBody?.starred === true || cleanupStarBody?.liked === true) {
    await toggleStar(api, reelId);
  }

  console.log("[pass] orbit star/save persistence test completed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
