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

function pickUserId(loginData) {
  const raw =
    loginData?.body?.user?.id ??
    loginData?.body?.id ??
    loginData?.user?.id ??
    0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
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
  const userId = pickUserId(response.data);
  assert(looksLikeJwt(token), `Invalid token for ${email}`);
  assert(userId > 0, `Invalid user id for ${email}`);

  return { token, userId };
}

function validatePost(item) {
  const keys = ["id", "excerpt", "createdAt", "counts", "media", "author", "liked", "saved"];
  keys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(item, key), `Post summary missing '${key}'`);
  });
}

function validateReel(item) {
  const keys = ["id", "description", "thumbnail_url", "stream_url", "video_uid", "counts", "creator", "createdAt"];
  keys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(item, key), `Reel summary missing '${key}'`);
  });
}

function validateService(item) {
  const keys = ["id", "title", "short_description", "price", "thumbnail", "provider", "status", "createdAt"];
  keys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(item, key), `Service summary missing '${key}'`);
  });
}

function validateNotification(item) {
  const keys = ["id", "type", "createdAt", "actor", "target", "read"];
  keys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(item, key), `Notification summary missing '${key}'`);
  });
}

function assertSections(body, expectedSections) {
  const actual = Object.keys(body?.sections || {}).sort();
  const expected = [...expectedSections].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Sections mismatch. expected=${expected.join(",")} actual=${actual.join(",")}`);
}

async function testGuestAll() {
  const api = makeApi();
  const response = await api.get(
    "/bootstrap/home?include=posts,reels,services,notifications&posts_size=99&reels_size=99&services_size=99&notifications_limit=99"
  );
  assert(response.status >= 200 && response.status < 300, `Guest bootstrap failed status=${response.status}`);

  const body = response.data?.body ?? {};
  assert(body?.meta?.authenticated === false, "Guest meta.authenticated must be false");
  assert(body?.meta?.userId == null, "Guest meta.userId must be null");
  assertSections(body, ["posts", "reels", "services"]);

  assert(Number(body.sections.posts.size) === 10, `Guest posts.size expected 10, got ${body.sections.posts.size}`);
  assert(Number(body.sections.reels.size) === 10, `Guest reels.size expected 10, got ${body.sections.reels.size}`);
  assert(Number(body.sections.services.size) === 10, `Guest services.size expected 10, got ${body.sections.services.size}`);
  if (Array.isArray(body.sections.posts.items) && body.sections.posts.items.length) validatePost(body.sections.posts.items[0]);
  if (Array.isArray(body.sections.reels.items) && body.sections.reels.items.length) validateReel(body.sections.reels.items[0]);
  if (Array.isArray(body.sections.services.items) && body.sections.services.items.length) validateService(body.sections.services.items[0]);

  return body;
}

async function testGuestInvalidIncludeFallback() {
  const api = makeApi();
  const response = await api.get("/bootstrap/home?include=foo,bar");
  assert(response.status >= 200 && response.status < 300, `Guest invalid include failed status=${response.status}`);

  const body = response.data?.body ?? {};
  assertSections(body, []);
}

async function testAuthAll() {
  const { token, userId } = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const api = makeApi(token);

  const response = await api.get(
    "/bootstrap/home?include=posts,reels,services,notifications&posts_size=99&reels_size=99&services_size=99&notifications_limit=99"
  );
  assert(response.status >= 200 && response.status < 300, `Auth bootstrap failed status=${response.status}`);

  const body = response.data?.body ?? {};
  assert(body?.meta?.authenticated === true, "Auth meta.authenticated must be true");
  assert(Number(body?.meta?.userId) === userId, `Auth meta.userId expected ${userId} got ${body?.meta?.userId}`);
  assertSections(body, ["posts", "reels", "services", "notifications"]);

  assert(Number(body.sections.posts.size) === 10, `Auth posts.size expected 10, got ${body.sections.posts.size}`);
  assert(Number(body.sections.reels.size) === 10, `Auth reels.size expected 10, got ${body.sections.reels.size}`);
  assert(Number(body.sections.services.size) === 10, `Auth services.size expected 10, got ${body.sections.services.size}`);
  assert(Number(body.sections.notifications.limit) === 10, `Auth notifications.limit expected 10, got ${body.sections.notifications.limit}`);

  if (Array.isArray(body.sections.posts.items) && body.sections.posts.items.length) validatePost(body.sections.posts.items[0]);
  if (Array.isArray(body.sections.reels.items) && body.sections.reels.items.length) validateReel(body.sections.reels.items[0]);
  if (Array.isArray(body.sections.services.items) && body.sections.services.items.length) validateService(body.sections.services.items[0]);
  if (Array.isArray(body.sections.notifications.items) && body.sections.notifications.items.length) {
    validateNotification(body.sections.notifications.items[0]);
  }

  const postsOnly = await api.get("/bootstrap/home?include=posts&posts_size=7");
  assert(postsOnly.status >= 200 && postsOnly.status < 300, `Auth posts-only bootstrap failed status=${postsOnly.status}`);
  assertSections(postsOnly.data?.body ?? {}, ["posts"]);
  assert(Number(postsOnly.data?.body?.sections?.posts?.size) === 7, "Auth posts-only expected size 7");
}

async function main() {
  await testGuestAll();
  await testGuestInvalidIncludeFallback();
  await testAuthAll();
  console.log("[ok] step 1 bootstrap/home summary checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
