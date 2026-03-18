#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const VIEWER_EMAIL = String(
  process.env.VIEWER_EMAIL || process.env.COMMENTER_EMAIL || "brainstorm.good@gmail.com"
).trim();
const VIEWER_PASSWORD = String(
  process.env.VIEWER_PASSWORD || process.env.COMMENTER_PASSWORD || "Eder2013#"
).trim();
const VIEWER_LOGIN_UUID = String(
  process.env.VIEWER_LOGIN_UUID || process.env.COMMENTER_LOGIN_UUID || ""
).trim();

const PAGE_LIMIT = Math.max(1, Math.min(Number(process.env.CHAT_LIST_PAGE_LIMIT || 5), 50));

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

function normalizeChatId(item) {
  const raw = item?.chatId ?? item?.id ?? item?.Chat?.id ?? 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function idsSet(items) {
  const set = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizeChatId(item);
    if (id > 0) set.add(id);
  }
  return set;
}

function decodeCursor(rawCursor) {
  const value = String(rawCursor || "").trim();
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

function validateCursorShape(cursor) {
  assert(cursor && typeof cursor === "object", "next_cursor is not a valid encoded payload");
  const chatId = Number(cursor.chatId);
  assert(Number.isFinite(chatId) && chatId > 0, "next_cursor payload chatId is invalid");
  const updatedAt = new Date(String(cursor.updatedAt || ""));
  assert(Number.isFinite(updatedAt.getTime()), "next_cursor payload updatedAt is invalid");
  if (cursor.pinnedAt != null) {
    const pinnedAt = new Date(String(cursor.pinnedAt));
    assert(Number.isFinite(pinnedAt.getTime()), "next_cursor payload pinnedAt is invalid");
  }
}

function assertSummaryShape(item) {
  assert(item && typeof item === "object", "summary item must be an object");
  assert(Number(normalizeChatId(item)) > 0, "summary item missing chatId");
  assert(Object.prototype.hasOwnProperty.call(item, "user"), "summary item missing user");
  assert(Object.prototype.hasOwnProperty.call(item, "unreadCount"), "summary item missing unreadCount");
}

function assertLegacyShape(item) {
  assert(item && typeof item === "object", "legacy item must be an object");
  assert(Number(normalizeChatId(item)) > 0, "legacy item missing chatId");
  assert(Object.prototype.hasOwnProperty.call(item, "Chat"), "legacy item missing Chat object");
}

async function verifyPagination(api, { summary }) {
  const prefix = summary ? "summary=1&" : "";
  const modeLabel = summary ? "summary" : "legacy";

  const first = await api.get(`/chat?${prefix}limit=${PAGE_LIMIT}`);
  assert(first.status >= 200 && first.status < 300, `${modeLabel} page1 failed status=${first.status}`);

  const firstBody = first.data?.body ?? {};
  const firstItems = Array.isArray(firstBody.chatsByUser) ? firstBody.chatsByUser : [];
  assert(firstItems.length <= PAGE_LIMIT, `${modeLabel} page1 exceeded limit=${PAGE_LIMIT}`);

  assert(firstBody.paging && typeof firstBody.paging === "object", `${modeLabel} paging missing`);
  assert(
    Number(firstBody?.paging?.limit) === PAGE_LIMIT,
    `${modeLabel} paging.limit expected ${PAGE_LIMIT}, got ${String(firstBody?.paging?.limit)}`
  );

  if (firstItems.length > 0) {
    if (summary) {
      assertSummaryShape(firstItems[0]);
    } else {
      assertLegacyShape(firstItems[0]);
    }
  }

  const nextCursor = String(firstBody?.paging?.next_cursor || "").trim() || null;
  if (!nextCursor) {
    console.log(`[warn] ${modeLabel} no next_cursor available (items=${firstItems.length}).`);
    return;
  }

  const decoded = decodeCursor(nextCursor);
  validateCursorShape(decoded);

  const second = await api.get(`/chat?${prefix}limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(nextCursor)}`);
  assert(second.status >= 200 && second.status < 300, `${modeLabel} page2 failed status=${second.status}`);

  const secondBody = second.data?.body ?? {};
  const secondItems = Array.isArray(secondBody.chatsByUser) ? secondBody.chatsByUser : [];
  assert(secondItems.length <= PAGE_LIMIT, `${modeLabel} page2 exceeded limit=${PAGE_LIMIT}`);

  const firstIds = idsSet(firstItems);
  const duplicated = secondItems
    .map((item) => normalizeChatId(item))
    .filter((id) => id > 0 && firstIds.has(id));
  assert(duplicated.length === 0, `${modeLabel} page2 repeated chat ids: ${JSON.stringify(duplicated)}`);

  console.log(
    `[pass] chat ${modeLabel} page1=${firstItems.length} page2=${secondItems.length} next_cursor=yes`
  );
}

async function verifyLimitCap(api, { summary }) {
  const prefix = summary ? "summary=1&" : "";
  const modeLabel = summary ? "summary" : "legacy";

  const response = await api.get(`/chat?${prefix}limit=999`);
  assert(response.status >= 200 && response.status < 300, `${modeLabel} cap request failed status=${response.status}`);

  const pagingLimit = Number(response.data?.body?.paging?.limit || 0);
  assert(pagingLimit === 100, `${modeLabel} expected capped paging.limit=100, got ${pagingLimit}`);

  const invalidCursor = await api.get(`/chat?${prefix}limit=${PAGE_LIMIT}&cursor=%%%invalid%%%`);
  assert(
    invalidCursor.status >= 200 && invalidCursor.status < 300,
    `${modeLabel} invalid cursor should not fail. status=${invalidCursor.status}`
  );

  console.log(`[pass] chat ${modeLabel} limit cap + invalid cursor fallback`);
}

async function main() {
  const token = await login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID);
  const api = makeApi(token);

  await verifyPagination(api, { summary: true });
  await verifyPagination(api, { summary: false });

  await verifyLimitCap(api, { summary: true });
  await verifyLimitCap(api, { summary: false });

  console.log("[ok] chat list pagination checks passed");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
