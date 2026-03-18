#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(
  process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || "info@minhoo.app"
).trim();
const OWNER_PASSWORD = String(
  process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || "Eder2010#"
).trim();
const OWNER_LOGIN_UUID = String(
  process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || ""
).trim();

const VIEWER_EMAIL = String(
  process.env.VIEWER_EMAIL || "brainstorm.good@gmail.com"
).trim();
const VIEWER_PASSWORD = String(
  process.env.VIEWER_PASSWORD || "Eder2013#"
).trim();
const VIEWER_LOGIN_UUID = String(process.env.VIEWER_LOGIN_UUID || "").trim();

const TARGET_POST_ID = Math.max(1, Number(process.env.TARGET_POST_ID || 415) || 415);
const POLL_ATTEMPTS = Math.max(6, Math.min(Number(process.env.NOTIFICATION_POLL_ATTEMPTS || 20), 60));
const POLL_WAIT_MS = Math.max(200, Math.min(Number(process.env.NOTIFICATION_POLL_WAIT_MS || 500), 2000));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
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
  const value = Number(
    loginData?.body?.user?.id ??
      loginData?.body?.id ??
      loginData?.user?.id ??
      0
  );
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
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

async function login(email, password, uuid) {
  const api = makeApi();
  const body = { email, password };
  if (String(uuid || "").trim().length >= 20) {
    body.uuid = String(uuid).trim();
  }

  const response = await api.post("/auth/login", body);
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

async function getMyLanguage(api) {
  const response = await api.get("/user/myData");
  assert(response.status >= 200 && response.status < 300, `GET /user/myData failed status=${response.status}`);
  return String(response?.data?.body?.user?.language || "").trim().toLowerCase();
}

async function updateLanguage(api, language) {
  const normalized = String(language || "").trim().toLowerCase();
  assert(normalized === "es" || normalized === "en", `Invalid language: ${language}`);

  const payload = { language: normalized };
  let response = await api.put("/user/profile", payload);

  if (!(response.status >= 200 && response.status < 300)) {
    response = await api.put("/worker/profile", payload);
  }

  assert(
    response.status >= 200 && response.status < 300,
    `Language update failed status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const after = await getMyLanguage(api);
  assert(after === normalized, `Expected language=${normalized}, received ${after || "(empty)"}`);
}

async function unsavePost(api, postId) {
  const response = await api.delete(`/saved/posts/${postId}`);
  assert(
    response.status >= 200 && response.status < 300,
    `DELETE /saved/posts/${postId} failed status=${response.status} body=${JSON.stringify(response.data)}`
  );
}

async function savePost(api, postId) {
  const response = await api.post(`/saved/posts/${postId}`, {});
  assert(
    response.status >= 200 && response.status < 300,
    `POST /saved/posts/${postId} failed status=${response.status} body=${JSON.stringify(response.data)}`
  );
}

async function readNotifications(api, limit = 50) {
  const response = await api.get(`/notification?limit=${limit}`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /notification failed status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const list = Array.isArray(response?.data?.body) ? response.data.body : [];
  return list;
}

function findMaxNotificationId(items) {
  let maxId = 0;
  for (const item of items) {
    const id = Number(item?.id || 0);
    if (Number.isFinite(id) && id > maxId) maxId = Math.trunc(id);
  }
  return maxId;
}

function findNewLikeNotification(items, { afterId, interactorId }) {
  return items.find((item) => {
    const id = Number(item?.id || 0);
    const type = String(item?.type || "").toLowerCase();
    const actor = Number(item?.interactorId || 0);
    return id > afterId && type === "like" && actor === interactorId;
  });
}

async function waitForLikeNotification(api, matcher) {
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    const notifications = await readNotifications(api, 60);
    const found = findNewLikeNotification(notifications, matcher);
    if (found) return found;
    await sleep(POLL_WAIT_MS);
  }
  return null;
}

async function main() {
  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] targetPostId=${TARGET_POST_ID}`);

  const [owner, viewer] = await Promise.all([
    login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID),
    login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID),
  ]);

  assert(owner.userId !== viewer.userId, "owner and viewer must be different users");

  const ownerApi = makeApi(owner.token);
  const viewerApi = makeApi(viewer.token);

  const originalOwnerLanguage = await getMyLanguage(ownerApi);
  const originalSafeLanguage = originalOwnerLanguage === "es" || originalOwnerLanguage === "en"
    ? originalOwnerLanguage
    : "en";

  try {
    await unsavePost(viewerApi, TARGET_POST_ID);

    // Case 1: owner in Spanish
    await updateLanguage(ownerApi, "es");
    const beforeEs = findMaxNotificationId(await readNotifications(ownerApi, 30));
    await savePost(viewerApi, TARGET_POST_ID);

    const esNotification = await waitForLikeNotification(ownerApi, {
      afterId: beforeEs,
      interactorId: viewer.userId,
    });
    assert(esNotification, "No new Spanish like notification found");

    const esMessage = String(esNotification?.message || "");
    assert(
      esMessage.includes("Ha guardado tu publicacion."),
      `Expected Spanish message, received: ${JSON.stringify(esMessage)}`
    );
    console.log(`[pass] locale=es notification message=${JSON.stringify(esMessage)}`);

    await unsavePost(viewerApi, TARGET_POST_ID);

    // Case 2: owner in English
    await updateLanguage(ownerApi, "en");
    const beforeEn = findMaxNotificationId(await readNotifications(ownerApi, 30));
    await savePost(viewerApi, TARGET_POST_ID);

    const enNotification = await waitForLikeNotification(ownerApi, {
      afterId: beforeEn,
      interactorId: viewer.userId,
    });
    assert(enNotification, "No new English like notification found");

    const enMessage = String(enNotification?.message || "");
    assert(
      enMessage.includes("Has saved your post."),
      `Expected English message, received: ${JSON.stringify(enMessage)}`
    );
    console.log(`[pass] locale=en notification message=${JSON.stringify(enMessage)}`);

    await unsavePost(viewerApi, TARGET_POST_ID);
    console.log("[ok] notification locale routing checks passed");
  } finally {
    try {
      await updateLanguage(ownerApi, originalSafeLanguage);
    } catch (error) {
      console.warn(
        `[warn] could not restore owner language to ${originalSafeLanguage}: ${error?.message || error}`
      );
    }

    try {
      await unsavePost(viewerApi, TARGET_POST_ID);
    } catch (_) {
      // ignore cleanup failure
    }
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
