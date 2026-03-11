#!/usr/bin/env node
"use strict";

const axios = require("axios");
const { io } = require("socket.io-client");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const SOCKET_URL = String(process.env.SOCKET_URL || "http://127.0.0.1:3000").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "info@minhoo.app").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || "Eder2010#").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || "").trim();
const COMMENTER_EMAIL = String(
  process.env.COMMENTER_EMAIL || "brainstorm.good@gmail.com"
).trim();
const COMMENTER_PASSWORD = String(process.env.COMMENTER_PASSWORD || "Eder2013#").trim();
const COMMENTER_LOGIN_UUID = String(process.env.COMMENTER_LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function looksLikeJwt(token) {
  const parts = String(token || "").split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
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

function makeApi(token = "") {
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

async function login(email, password, uuid) {
  assert(email, "Missing email");
  assert(password, `Missing password for ${email}`);

  const api = makeApi("");
  const body = { email, password };
  if (String(uuid || "").trim().length >= 20) {
    body.uuid = String(uuid).trim();
  }
  const response = await api.post("/auth/login", body);
  assert(
    response.status >= 200 && response.status < 300,
    `Login failed for ${email}. status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );

  const token = pickToken(response.data);
  const userId = pickUserId(response.data);
  assert(looksLikeJwt(token), `Invalid token for ${email}`);
  assert(userId > 0, `Invalid user id for ${email}`);

  return { token, userId };
}

function waitForConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Socket connect timeout")),
      timeoutMs
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function toReelId(payload) {
  const n = Number(
    payload?.reelId ?? payload?.reel_id ?? payload?.id ?? payload?.reel?.id
  );
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function main() {
  const owner = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const commenter = await login(
    COMMENTER_EMAIL,
    COMMENTER_PASSWORD,
    COMMENTER_LOGIN_UUID
  );
  assert(owner.userId !== commenter.userId, "owner/commenter must be different users");

  const apiOwner = makeApi(owner.token);
  const apiCommenter = makeApi(commenter.token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] SOCKET_URL=${SOCKET_URL}`);
  console.log(`[test] ownerId=${owner.userId} commenterId=${commenter.userId}`);

  const received = [];
  const channels = new Set();

  const socket = io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    timeout: TIMEOUT_MS,
    auth: { token: owner.token },
    query: { token: owner.token },
  });

  try {
    await waitForConnect(socket, TIMEOUT_MS);
    console.log("[pass] socket connected");

    const onEvent = (channel) => (payload) => {
      channels.add(channel);
      received.push({ channel, payload });
    };

    socket.on("reel/commented", onEvent("reel/commented"));
    socket.on("orbit/commented", onEvent("orbit/commented"));
    socket.on("find/reel/commented", onEvent("find/reel/commented"));
    socket.on("reels", onEvent("reels"));

    const createResponse = await apiOwner.post("/reel", {
      description: "tmp orbit comment realtime test",
      stream_url: "https://example.com/orbit-comment-realtime.m3u8",
      thumbnail_url: "https://example.com/orbit-comment-realtime.jpg",
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
      const commentResponse = await apiCommenter.post(`/reel/${reelId}/comments`, {
        comment: `orbit-comment-realtime-${Date.now()}`,
      });
      assert(
        commentResponse.status >= 200 && commentResponse.status < 300,
        `POST /reel/${reelId}/comments failed status=${commentResponse.status} body=${JSON.stringify(
          commentResponse.data
        )}`
      );

      const startedAt = Date.now();
      while (Date.now() - startedAt < TIMEOUT_MS) {
        const matched = received.find((entry) => toReelId(entry.payload) === reelId);
        if (matched) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }

      const matchedEvents = received.filter((entry) => toReelId(entry.payload) === reelId);
      assert(matchedEvents.length > 0, "No realtime orbit comment event received");

      const matchedChannels = [...new Set(matchedEvents.map((entry) => entry.channel))];
      assert(matchedChannels.includes("reel/commented"), "Missing channel reel/commented");
      assert(matchedChannels.includes("orbit/commented"), "Missing channel orbit/commented");

      console.log(
        `[pass] realtime orbit comment events received channels=${matchedChannels.join(",")}`
      );
      console.log("[pass] orbit comment realtime is working");
    } finally {
      await apiOwner.delete(`/reel/${reelId}`);
    }
  } finally {
    socket.removeAllListeners();
    socket.close();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
