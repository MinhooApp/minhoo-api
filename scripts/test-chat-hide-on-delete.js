#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || process.env.LOGIN_UUID || "").trim();

const VIEWER_EMAIL = String(
  process.env.VIEWER_EMAIL || process.env.COMMENTER_EMAIL || "brainstorm.good@gmail.com"
).trim();
const VIEWER_PASSWORD = String(
  process.env.VIEWER_PASSWORD || process.env.COMMENTER_PASSWORD || "Eder2013#"
).trim();
const VIEWER_LOGIN_UUID = String(
  process.env.VIEWER_LOGIN_UUID || process.env.COMMENTER_LOGIN_UUID || ""
).trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeApi(token = "") {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: token
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
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
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function normalizeChatItems(data) {
  const body = data?.body ?? {};
  const items = Array.isArray(body?.chatsByUser) ? body.chatsByUser : [];
  return items;
}

function normalizeChatId(item) {
  const raw = item?.chatId ?? item?.id ?? item?.Chat?.id ?? 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function chatListContains(chatItems, chatId) {
  return chatItems.some((item) => normalizeChatId(item) === Number(chatId));
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
  assert(userId > 0, `Invalid userId for ${email}`);
  return { token, userId };
}

async function fetchChats(api) {
  const response = await api.get("/chat?summary=1&limit=100");
  assert(response.status >= 200 && response.status < 300, `GET /chat failed status=${response.status}`);
  return normalizeChatItems(response.data);
}

async function fetchMessages(api, otherUserId) {
  const response = await api.get(`/chat/message/${otherUserId}?summary=1&limit=20&sort=desc`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /chat/message/${otherUserId} failed status=${response.status}`
  );
  const body = response.data?.body ?? {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return { chatId: Number(body?.chatId || 0), messages };
}

async function sendMessage(api, userId, message) {
  const response = await api.post("/chat", { userId, message });
  assert(
    response.status >= 200 && response.status < 300,
    `POST /chat failed status=${response.status} body=${JSON.stringify(response.data)}`
  );
  const body = response.data?.body ?? {};
  const chatId = Number(body?.chatId || 0);
  assert(chatId > 0, "POST /chat did not return valid chatId");
  return chatId;
}

async function deleteChat(api, chatId) {
  const response = await api.delete(`/chat/${chatId}`);
  assert(
    response.status >= 200 && response.status < 300,
    `DELETE /chat/${chatId} failed status=${response.status} body=${JSON.stringify(response.data)}`
  );
}

async function main() {
  const owner = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const viewer = await login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID);
  assert(owner.userId !== viewer.userId, "Owner and viewer must be different users");

  const ownerApi = makeApi(owner.token);
  const viewerApi = makeApi(viewer.token);

  const seedA = `hide-seed-a-${Date.now()}`;
  const seedB = `hide-seed-b-${Date.now()}`;
  const reopenMsg = `hide-reopen-${Date.now()}`;

  const chatIdA = await sendMessage(ownerApi, viewer.userId, seedA);
  const chatIdB = await sendMessage(viewerApi, owner.userId, seedB);
  assert(chatIdA === chatIdB, `Chat id mismatch owner=${chatIdA} viewer=${chatIdB}`);
  const chatId = chatIdA;

  const ownerChatsBefore = await fetchChats(ownerApi);
  assert(chatListContains(ownerChatsBefore, chatId), "Owner should see chat before delete");

  await deleteChat(ownerApi, chatId);

  const ownerChatsAfterDelete = await fetchChats(ownerApi);
  assert(!chatListContains(ownerChatsAfterDelete, chatId), "Owner chat must be hidden after delete");

  const viewerChatsAfterDelete = await fetchChats(viewerApi);
  assert(chatListContains(viewerChatsAfterDelete, chatId), "Viewer must keep seeing chat after owner delete");

  const ownerRelogin = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const ownerApiRelogin = makeApi(ownerRelogin.token);
  const ownerChatsAfterRelogin = await fetchChats(ownerApiRelogin);
  assert(
    !chatListContains(ownerChatsAfterRelogin, chatId),
    "Owner chat must stay hidden after app reopen/login"
  );

  const chatIdReopen = await sendMessage(viewerApi, owner.userId, reopenMsg);
  assert(chatIdReopen === chatId, "Chat should reopen in the same chatId");

  const ownerChatsAfterNewMessage = await fetchChats(ownerApiRelogin);
  assert(chatListContains(ownerChatsAfterNewMessage, chatId), "Owner chat must reappear after new message");

  const { chatId: messageChatId, messages } = await fetchMessages(ownerApiRelogin, viewer.userId);
  assert(messageChatId === chatId, "Messages endpoint returned different chatId");
  const texts = messages.map((m) => String(m?.text ?? m?.message ?? "")).filter(Boolean);
  assert(
    texts.some((text) => text.includes(reopenMsg)),
    "Reopen message not found in owner message list"
  );
  assert(
    texts.some((text) => text.includes(seedA) || text.includes(seedB)),
    "Old history message not found after reopen"
  );

  console.log("[pass] chat delete hides for actor only and reopens with history on new message");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
