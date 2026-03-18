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

function getAuthToken(data) {
  return String(
    data?.body?.user?.auth_token ??
      data?.body?.auth_token ??
      data?.body?.token ??
      data?.token ??
      ""
  ).trim();
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

function readBool(source, camelKey, snakeKey, fallback = false) {
  if (!source || typeof source !== "object") return fallback;
  if (typeof source[camelKey] === "boolean") return source[camelKey];
  if (typeof source[snakeKey] === "boolean") return source[snakeKey];
  return Boolean(source[camelKey] ?? source[snakeKey] ?? fallback);
}

function readString(source, camelKey, snakeKey) {
  if (!source || typeof source !== "object") return null;
  const value = source[camelKey] ?? source[snakeKey];
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  return out.length ? out : null;
}

function toTs(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

async function main() {
  const token = await loginIfNeeded();
  const api = buildApi(token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);

  const createResponse = await api.post("/reel", {
    description: "tmp orbit ring 24h test",
    stream_url: "https://example.com/orbit-ring-24h.m3u8",
    thumbnail_url: "https://example.com/orbit-ring-24h.jpg",
    visibility: "public",
    allow_download: false,
  });

  assert(
    createResponse.status >= 200 && createResponse.status < 300,
    `POST /reel failed status=${createResponse.status} body=${JSON.stringify(
      createResponse.data
    )}`
  );

  const reelId = Number(createResponse?.data?.body?.reel?.id || 0);
  assert(reelId > 0, "create reel did not return valid id");
  console.log(`[test] created reelId=${reelId}`);

  try {
    const myResponse = await api.get("/reel/my?page=0&size=20");
    assert(
      myResponse.status >= 200 && myResponse.status < 300,
      `GET /reel/my failed status=${myResponse.status} body=${JSON.stringify(
        myResponse.data
      )}`
    );

    const reels = myResponse?.data?.body?.reels;
    assert(Array.isArray(reels), "reels is not an array in /reel/my");

    const reel = reels.find((item) => Number(item?.id) === reelId);
    assert(reel, "created reel was not found in /reel/my");

    const ringActive = readBool(reel, "ringActive", "ring_active", false);
    const ringUntil = readString(reel, "ringUntil", "ring_until");
    const isNew = readBool(reel, "isNew", "is_new", false);
    const newUntil = readString(reel, "newUntil", "new_until");
    assert(ringActive === true, "expected ring_active/ringActive=true on fresh reel");
    assert(!!ringUntil, "expected ring_until/ringUntil on fresh reel");
    assert(isNew === true, "expected is_new/isNew=true on fresh reel");
    assert(!!newUntil, "expected new_until/newUntil on fresh reel");

    const now = Date.now();
    const ringUntilTs = toTs(ringUntil);
    const newUntilTs = toTs(newUntil);
    assert(ringUntilTs > now, "ring_until/ringUntil should be in the future");
    assert(
      ringUntilTs <= now + 25 * 60 * 60 * 1000,
      "ring_until/ringUntil should be around 24h window"
    );
    assert(newUntilTs > now, "new_until/newUntil should be in the future");
    assert(
      newUntilTs <= now + 25 * 60 * 60 * 1000,
      "new_until/newUntil should be around 24h window"
    );
    assert(
      Math.abs(ringUntilTs - newUntilTs) <= 2000,
      "ring_until/ringUntil and new_until/newUntil should match"
    );

    const user = reel?.user || {};
    const hasOrbitRing = readBool(user, "hasOrbitRing", "has_orbit_ring", false);
    const orbitRingUntil = readString(user, "orbitRingUntil", "orbit_ring_until");

    assert(hasOrbitRing === true, "expected user has_orbit_ring/hasOrbitRing=true");
    assert(!!orbitRingUntil, "expected user orbit_ring_until/orbitRingUntil");

    const orbitRingUntilTs = toTs(orbitRingUntil);
    assert(orbitRingUntilTs > now, "orbit ring until should be in the future");
    assert(
      orbitRingUntilTs <= now + 25 * 60 * 60 * 1000,
      "orbit ring until should be around 24h window"
    );

    console.log("[pass] reel ring_active/ring_until + is_new/new_until is correct");
    console.log("[pass] user has_orbit_ring/orbit_ring_until is correct");
    console.log("[pass] orbit avatar ring 24h test completed");
  } finally {
    await api.delete(`/reel/${reelId}`);
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
