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
const OWNER_EMAIL = String(
  process.env.OWNER_EMAIL || process.env.TARGET_EMAIL || ""
).trim();
const OWNER_PASSWORD = String(
  process.env.OWNER_PASSWORD || process.env.TARGET_PASSWORD || ""
).trim();
const OWNER_LOGIN_UUID = String(
  process.env.OWNER_LOGIN_UUID || process.env.TARGET_LOGIN_UUID || process.env.LOGIN_UUID || ""
).trim();
const VIEWER_EMAIL = String(
  process.env.VIEWER_EMAIL || process.env.COMMENTER_EMAIL || ""
).trim();
const VIEWER_PASSWORD = String(
  process.env.VIEWER_PASSWORD || process.env.COMMENTER_PASSWORD || ""
).trim();
const VIEWER_LOGIN_UUID = String(
  process.env.VIEWER_LOGIN_UUID || process.env.COMMENTER_LOGIN_UUID || ""
).trim();

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

async function loginWithEmail(email, password, uuid) {
  assert(email, "Missing email for chat realtime login");
  assert(password, `Missing password for ${email}`);

  const body = { email, password };
  if (String(uuid || "").trim().length >= 20) body.uuid = String(uuid).trim();

  const response = await axios.post(`${API_BASE_URL}/auth/login`, body, {
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });

  assert(
    response.status >= 200 && response.status < 300,
    `Login failed for ${email}. status=${response.status} body=${JSON.stringify(response.data)}`
  );

  const token = pickToken(response.data);
  const userId = pickUserId(response.data);
  assert(isLikelyJwt(token), `login token inválido para ${email}`);
  assert(userId > 0, `login userId inválido para ${email}`);

  return { token, userId };
}

async function resolveRuntimeAuth() {
  const hasTokenA =
    TOKEN_A &&
    !looksLikePlaceholderToken(TOKEN_A) &&
    isLikelyJwt(TOKEN_A);
  const hasTokenB =
    TOKEN_B &&
    !looksLikePlaceholderToken(TOKEN_B) &&
    isLikelyJwt(TOKEN_B);

  if (hasTokenA && hasTokenB) {
    const userA = resolveUserId(USER_A_ENV, TOKEN_A);
    const userB = resolveUserId(USER_B_ENV, TOKEN_B);
    assert(userA > 0, "Missing valid USER_A (env or token payload)");
    assert(userB > 0, "Missing valid USER_B (env or token payload)");
    assert(userA !== userB, "USER_A and USER_B must be different users");
    return { tokenA: TOKEN_A, tokenB: TOKEN_B, userA, userB };
  }

  const [owner, viewer] = await Promise.all([
    loginWithEmail(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID),
    loginWithEmail(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID),
  ]);
  assert(owner.userId !== viewer.userId, "owner/viewer must be different users");
  return {
    tokenA: owner.token,
    tokenB: viewer.token,
    userA: owner.userId,
    userB: viewer.userId,
  };
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
  const { tokenA, tokenB, userA, userB } = await resolveRuntimeAuth();

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] SOCKET_URL=${SOCKET_URL}`);
  console.log(`[test] userA=${userA} userB=${userB}`);

  const apiA = createApi(tokenA);
  const apiB = createApi(tokenB);
  await assertHttpTokenValid(apiA, "A");
  await assertHttpTokenValid(apiB, "B");
  console.log("[pass] token HTTP válido en /chat");

  const socketA = await connectSocket({ token: tokenA, userId: userA, label: "A" });
  const socketB = await connectSocket({ token: tokenB, userId: userB, label: "B" });

  try {
    await bindUser(socketA, userA, tokenA, "A");
    await bindUser(socketB, userB, tokenB, "B");
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
