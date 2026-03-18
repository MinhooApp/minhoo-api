#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || "").trim();

const VIEWER_EMAIL = String(process.env.VIEWER_EMAIL || "brainstorm.good@gmail.com").trim();
const VIEWER_PASSWORD = String(process.env.VIEWER_PASSWORD || "Eder2013#").trim();
const VIEWER_LOGIN_UUID = String(process.env.VIEWER_LOGIN_UUID || "").trim();

const SEED_MESSAGES = Math.max(1, Math.min(Number(process.env.CHAT_SUMMARY_SEED_MESSAGES || 6), 20));

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
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
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

async function sendMessage(api, receiverUserId, text) {
  const response = await api.post("/chat", { userId: receiverUserId, message: text });
  assert(
    response.status >= 200 && response.status < 300,
    `POST /chat failed status=${response.status} body=${JSON.stringify(response.data)}`
  );
}

function getMinMessageId(messages) {
  let minId = Number.POSITIVE_INFINITY;
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = Number(message?.id);
    if (Number.isFinite(id) && id > 0) {
      minId = Math.min(minId, Math.trunc(id));
    }
  }
  return Number.isFinite(minId) && minId > 0 ? minId : null;
}

function validateMessageShape(message) {
  const requiredKeys = [
    "id",
    "text",
    "type",
    "senderId",
    "date",
    "status",
    "mediaUrl",
    "sender",
    "replyToMessageId",
  ];

  requiredKeys.forEach((key) => {
    assert(
      Object.prototype.hasOwnProperty.call(message, key),
      `Message is missing required key: ${key}`
    );
  });
}

async function main() {
  const [owner, viewer] = await Promise.all([
    login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID),
    login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID),
  ]);

  assert(owner.userId !== viewer.userId, "Owner and viewer must be different users");

  const apiOwner = makeApi(owner.token);

  for (let i = 0; i < SEED_MESSAGES; i += 1) {
    const uniqueText = `summary-step5-${Date.now()}-${i}`;
    await sendMessage(apiOwner, viewer.userId, uniqueText);
  }

  const page1 = await apiOwner.get(
    `/chat/message/${viewer.userId}?summary=1&limit=3&sort=asc`
  );
  assert(page1.status >= 200 && page1.status < 300, `Page1 failed status=${page1.status}`);

  const page1Body = page1.data?.body ?? {};
  const page1Messages = Array.isArray(page1Body.messages) ? page1Body.messages : [];
  assert(page1Messages.length > 0, "Page1 returned no messages");

  validateMessageShape(page1Messages[0]);

  const nextBeforeFromBody =
    Number(page1Body?.paging?.next_before_message_id ?? page1Body?.paging?.nextBeforeMessageId ?? 0) || null;
  const nextBeforeFromHeader = Number(page1.headers?.["x-paging-next-before-message-id"] || 0) || null;
  const nextBeforeMessageId = nextBeforeFromBody || nextBeforeFromHeader || getMinMessageId(page1Messages);

  let page2Messages = [];
  if (nextBeforeMessageId) {
    const page2 = await apiOwner.get(
      `/chat/message/${viewer.userId}?summary=1&limit=3&sort=asc&beforeMessageId=${nextBeforeMessageId}`
    );
    assert(page2.status >= 200 && page2.status < 300, `Page2 failed status=${page2.status}`);
    page2Messages = Array.isArray(page2.data?.body?.messages) ? page2.data.body.messages : [];

    const page1Ids = new Set(page1Messages.map((message) => Number(message?.id)).filter((id) => Number.isFinite(id)));
    const repeated = page2Messages
      .map((message) => Number(message?.id))
      .filter((id) => Number.isFinite(id) && page1Ids.has(id));
    assert(repeated.length === 0, `Pagination repeated message ids: ${JSON.stringify(repeated)}`);
  }

  const capped = await apiOwner.get(`/chat/message/${viewer.userId}?summary=1&limit=500&sort=asc`);
  assert(capped.status >= 200 && capped.status < 300, `Limit cap request failed status=${capped.status}`);
  const cappedLimit = Number(capped.data?.body?.paging?.limit ?? 0);
  assert(cappedLimit === 200, `Expected paging.limit=200, received ${cappedLimit}`);

  console.log(
    `[pass] chat/message summary page1=${page1Messages.length} page2=${page2Messages.length} nextBefore=${nextBeforeMessageId || "null"}`
  );
  console.log("[pass] chat/message summary enforces max limit 200");
  console.log("[ok] step 5 chat message summary checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
