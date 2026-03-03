#!/usr/bin/env node
"use strict";

const axios = require("axios");
const { io } = require("socket.io-client");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1").trim();
const SOCKET_URL = String(process.env.SOCKET_URL || "http://127.0.0.1:3000").trim();

const TOKEN_A = String(process.env.TOKEN_A || "").trim();
const TOKEN_B = String(process.env.TOKEN_B || "").trim();
const USER_A_ENV = Number(process.env.USER_A || 0);
const USER_B_ENV = Number(process.env.USER_B || 0);

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 12000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function looksLikePlaceholderToken(value) {
  const token = String(value || "").trim();
  if (!token) return true;
  if (token.includes("...")) return true;
  if (/TOKEN_USUARIO|TOKEN_A|TOKEN_B/i.test(token)) return true;
  return false;
}

function isLikelyJwt(value) {
  const token = String(value || "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => part.length > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceWithTimeout(socket, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting event=${event}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, onEvent);
    };

    const onEvent = (payload) => {
      cleanup();
      resolve(payload);
    };

    socket.once(event, onEvent);
  });
}

function decodeUserIdFromJwt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return 0;
    const payloadRaw = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw);
    const candidates = [payload.userId, payload.id, payload.uid, payload.sub];
    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  } catch (_) {
    return 0;
  }
}

function resolveUserId(explicitUserId, token) {
  if (Number.isFinite(explicitUserId) && explicitUserId > 0) return explicitUserId;
  const fromToken = decodeUserIdFromJwt(token);
  return fromToken > 0 ? fromToken : 0;
}

function createApi(token) {
  return axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

async function assertHttpTokenValid(api, label) {
  try {
    await api.get("/chat");
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const body = error?.response?.data;
    if (status === 401 || status === 403) {
      throw new Error(
        `[${label}] token inválido/revocado para HTTP (${status}). response=${JSON.stringify(
          body
        )}`
      );
    }
    throw error;
  }
}

function connectSocket({ token, userId, label }) {
  return new Promise((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      timeout: TIMEOUT_MS,
      auth: {
        token,
        userId,
      },
      query: {
        token,
        userId,
      },
      reconnection: false,
      autoConnect: true,
    });

    const timer = setTimeout(() => {
      socket.removeAllListeners();
      socket.disconnect();
      reject(new Error(`socket ${label} connect timeout`));
    }, TIMEOUT_MS);

    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.disconnect();
      reject(new Error(`socket ${label} connect_error: ${error.message}`));
    });

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function extractResponseBody(responseData) {
  if (!responseData || typeof responseData !== "object") return null;
  if (responseData.body && typeof responseData.body === "object") return responseData.body;
  return responseData;
}

async function bindUser(socket, userId, token, label) {
  const authErrorPromise = onceWithTimeout(socket, "auth:error", 2500).catch(() => null);
  const okPromise = onceWithTimeout(socket, "bind-user:ok", 5000);
  socket.emit("bind-user", { userId, token });

  const result = await okPromise;
  const authError = await authErrorPromise;
  assert(!authError, `[${label}] unexpected auth:error on bind-user: ${JSON.stringify(authError)}`);
  assert(Number(result?.userId) === userId, `[${label}] bind-user:ok userId mismatch`);
}

async function testChatsIsolation(socketA, socketB, userA, userB) {
  let aChatsCount = 0;
  let bChatsCount = 0;
  let bChatsAEventCount = 0;

  const onAChats = () => {
    aChatsCount += 1;
  };
  const onBChats = () => {
    bChatsCount += 1;
  };
  const onBChatsA = () => {
    bChatsAEventCount += 1;
  };

  socketA.on("chats", onAChats);
  socketB.on("chats", onBChats);
  socketB.on(`chats/${userA}`, onBChatsA);

  socketA.emit("chats", { userId: userA });
  await sleep(700);

  assert(aChatsCount > 0, "A should receive its own chats refresh");
  assert(bChatsAEventCount === 0, "B must NOT receive chats/{A} refresh");

  const authErrPromise = onceWithTimeout(socketA, "auth:error", 5000);
  socketA.emit("chats", { userId: userB });
  const authErr = await authErrPromise;
  assert(authErr?.code === "USER_MISMATCH", "expected USER_MISMATCH on chats event");

  socketA.off("chats", onAChats);
  socketB.off("chats", onBChats);
  socketB.off(`chats/${userA}`, onBChatsA);
}

async function testRealtimeDmDelivery({ apiA, socketA, socketB, userA, userB }) {
  const seedMessage = `seed-${Date.now()}`;
  const sendSeed = await apiA.post("/chat", { userId: userB, message: seedMessage });
  const seedBody = extractResponseBody(sendSeed.data);
  const chatId = Number(seedBody?.chatId || 0);
  assert(chatId > 0, "send /chat did not return valid chatId");

  socketA.emit("chat:join", { chatId, userId: userA });
  socketB.emit("chat:join", { chatId, userId: userB });
  await sleep(400);

  const targetEvent = `room/chat/${chatId}`;
  const receivedByBPromise = onceWithTimeout(socketB, targetEvent, 7000);
  const realtimeMessage = `rt-${Date.now()}`;
  await apiA.post("/chat", { userId: userB, message: realtimeMessage });
  const receivedPayload = await receivedByBPromise;

  const normalizedText = String(
    receivedPayload?.text ??
      receivedPayload?.message ??
      receivedPayload?.body?.text ??
      ""
  );
  assert(
    normalizedText.includes(realtimeMessage),
    `B did not receive expected realtime message text. got=${normalizedText}`
  );
}

async function testForbiddenChatJoin(socketA, userA) {
  const impossibleChatId = 99999999;
  const authErrPromise = onceWithTimeout(socketA, "auth:error", 5000);
  socketA.emit("chat:join", { chatId: impossibleChatId, userId: userA });
  const authErr = await authErrPromise;
  assert(authErr?.event === "chat:join", "expected auth:error for chat:join");
  assert(authErr?.code === "FORBIDDEN_CHAT", "expected FORBIDDEN_CHAT for invalid membership");
}

async function main() {
  assert(TOKEN_A, "Missing TOKEN_A");
  assert(TOKEN_B, "Missing TOKEN_B");
  assert(!looksLikePlaceholderToken(TOKEN_A), "TOKEN_A parece placeholder (usa JWT real)");
  assert(!looksLikePlaceholderToken(TOKEN_B), "TOKEN_B parece placeholder (usa JWT real)");
  assert(isLikelyJwt(TOKEN_A), "TOKEN_A no parece JWT válido");
  assert(isLikelyJwt(TOKEN_B), "TOKEN_B no parece JWT válido");

  const userA = resolveUserId(USER_A_ENV, TOKEN_A);
  const userB = resolveUserId(USER_B_ENV, TOKEN_B);
  assert(userA > 0, "Missing valid USER_A (env or token payload)");
  assert(userB > 0, "Missing valid USER_B (env or token payload)");
  assert(userA !== userB, "USER_A and USER_B must be different users");

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] SOCKET_URL=${SOCKET_URL}`);
  console.log(`[test] userA=${userA} userB=${userB}`);

  const apiA = createApi(TOKEN_A);
  const apiB = createApi(TOKEN_B);
  await assertHttpTokenValid(apiA, "A");
  await assertHttpTokenValid(apiB, "B");
  console.log("[pass] token HTTP válido en /chat");

  const socketA = await connectSocket({ token: TOKEN_A, userId: userA, label: "A" });
  const socketB = await connectSocket({ token: TOKEN_B, userId: userB, label: "B" });

  try {
    await bindUser(socketA, userA, TOKEN_A, "A");
    await bindUser(socketB, userB, TOKEN_B, "B");
    console.log("[pass] bind-user");

    await testChatsIsolation(socketA, socketB, userA, userB);
    console.log("[pass] chats isolation + user mismatch auth");

    await testRealtimeDmDelivery({ apiA, socketA, socketB, userA, userB });
    console.log("[pass] realtime DM delivery");

    await testForbiddenChatJoin(socketA, userA);
    console.log("[pass] forbidden chat join");

    console.log("[ok] chat realtime tests passed");
  } finally {
    socketA.disconnect();
    socketB.disconnect();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error.message}`);
  process.exit(1);
});
