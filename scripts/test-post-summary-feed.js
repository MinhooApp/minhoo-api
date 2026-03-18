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

function validatePostSummaryShape(post) {
  assert(post && typeof post === "object", "Post summary item must be an object");

  const requiredKeys = ["id", "excerpt", "createdAt", "counts", "media", "author", "liked", "saved"];
  requiredKeys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(post, key), `Post summary is missing key '${key}'`);
  });

  assert(post.counts && typeof post.counts === "object", "Post summary 'counts' must be object");
  ["likes", "comments", "saves", "shares"].forEach((key) => {
    assert(
      Object.prototype.hasOwnProperty.call(post.counts, key),
      `Post summary counts is missing key '${key}'`
    );
  });

  assert(post.author && typeof post.author === "object", "Post summary 'author' must be object");
  ["id", "username", "avatar", "verified"].forEach((key) => {
    assert(
      Object.prototype.hasOwnProperty.call(post.author, key),
      `Post summary author is missing key '${key}'`
    );
  });

  assert(typeof post.liked === "boolean", "Post summary 'liked' must be boolean");
  assert(typeof post.saved === "boolean", "Post summary 'saved' must be boolean");
}

async function verifyFeed(api, endpoint, label) {
  const response = await api.get(`${endpoint}?page=0&size=50&summary=1`);
  assert(response.status >= 200 && response.status < 300, `${label} failed status=${response.status}`);

  const body = response.data?.body ?? {};
  const posts = Array.isArray(body.posts) ? body.posts : [];

  assert(Number(body.page) === 0, `${label} expected page=0, got ${body.page}`);
  assert(Number(body.size) === 20, `${label} expected size=20 cap, got ${body.size}`);
  assert(posts.length <= 20, `${label} expected <=20 posts, got ${posts.length}`);

  if (posts.length > 0) {
    validatePostSummaryShape(posts[0]);
  }

  return posts.length;
}

async function main() {
  const guestApi = makeApi();
  const guestPosts = await verifyFeed(guestApi, "/post", "guest /post summary");
  const guestSuggested = await verifyFeed(guestApi, "/post/suggested", "guest /post/suggested summary");

  const token = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const authApi = makeApi(token);
  const authPosts = await verifyFeed(authApi, "/post", "auth /post summary");
  const authSuggested = await verifyFeed(
    authApi,
    "/post/suggested",
    "auth /post/suggested summary"
  );

  console.log(
    `[pass] post summary guest_posts=${guestPosts} guest_suggested=${guestSuggested} auth_posts=${authPosts} auth_suggested=${authSuggested}`
  );
  console.log("[ok] step 6 post summary checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
