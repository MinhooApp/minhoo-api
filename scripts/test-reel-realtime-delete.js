#!/usr/bin/env node
"use strict";

const axios = require("axios");
const { io } = require("socket.io-client");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const SOCKET_URL = String(process.env.SOCKET_URL || "http://127.0.0.1:3000").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 15000);
const EXPECT_REELS_DELETE_CHANNEL =
  String(process.env.EXPECT_REELS_DELETE_CHANNEL || "").trim().toLowerCase() ===
  "1";

const TOKEN = String(process.env.TOKEN || "").trim();
const EMAIL = String(process.env.EMAIL || "info@minhoo.app").trim();
const PASSWORD = String(process.env.PASSWORD || "Eder2010#").trim();
const LOGIN_UUID = String(process.env.LOGIN_UUID || "").trim();

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

function buildApi(token = "") {
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

  const token = pickToken(response.data);
  assert(looksLikeJwt(token), "Login did not return a valid JWT token");
  return token;
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

function isDeletePayload(payload) {
  const action = String(payload?.action ?? "").trim().toLowerCase();
  if (action === "deleted") return true;
  if (payload?.deleted === true || payload?.removed === true) return true;
  if (payload?.deletedAt || payload?.deleted_at) return true;
  return false;
}

function toUserId(payload) {
  const n = Number(
    payload?.userId ??
      payload?.user_id ??
      payload?.ownerId ??
      payload?.owner_id ??
      payload?.user?.id ??
      payload?.user?.userId
  );
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function main() {
  const token = await loginIfNeeded();
  const api = buildApi(token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] SOCKET_URL=${SOCKET_URL}`);

  const receivedChannels = new Set();
  const receivedPayloads = [];
  const ringEvents = [];

  const socket = io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    timeout: TIMEOUT_MS,
    auth: { token },
    query: { token },
  });

  try {
    await waitForConnect(socket, TIMEOUT_MS);
    console.log("[pass] socket connected");

    const onEvent = (channel) => (payload) => {
      receivedChannels.add(channel);
      receivedPayloads.push({ channel, payload });
    };
    const onRingUpdated = (payload) => {
      ringEvents.push({ ts: Date.now(), payload });
    };

    socket.on("reel/deleted", onEvent("reel/deleted"));
    socket.on("orbit/deleted", onEvent("orbit/deleted"));
    socket.on("find/reel/deleted", onEvent("find/reel/deleted"));
    socket.on("reels", onEvent("reels"));
    socket.on("orbit/ring-updated", onRingUpdated);

    const createResponse = await api.post("/reel", {
      description: "tmp reel realtime delete test",
      stream_url: "https://example.com/test-orbit-delete.m3u8",
      thumbnail_url: "https://example.com/test-orbit-delete.jpg",
      allow_download: false,
      visibility: "public",
    });

    assert(
      createResponse.status >= 200 && createResponse.status < 300,
      `POST /reel failed status=${createResponse.status} body=${JSON.stringify(
        createResponse.data
      )}`
    );

    const reelId = Number(createResponse?.data?.body?.reel?.id || 0);
    const ownerId = toUserId(createResponse?.data?.body?.reel ?? {});
    assert(reelId > 0, "create reel did not return valid id");
    console.log(`[test] created reelId=${reelId}`);

    const deleteStartedAt = Date.now();
    const deleteResponse = await api.delete(`/reel/${reelId}`);
    assert(
      deleteResponse.status >= 200 && deleteResponse.status < 300,
      `DELETE /reel/${reelId} failed status=${deleteResponse.status} body=${JSON.stringify(
        deleteResponse.data
      )}`
    );
    assert(deleteResponse?.data?.body?.deleted === true, "delete response deleted!=true");
    console.log("[pass] delete API ok");

    const started = Date.now();
    while (Date.now() - started < TIMEOUT_MS) {
      const matched = receivedPayloads.find(
        (entry) =>
          toReelId(entry.payload) === reelId && isDeletePayload(entry.payload)
      );
      if (matched) {
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }

    const matchedEvents = receivedPayloads.filter(
      (entry) => toReelId(entry.payload) === reelId && isDeletePayload(entry.payload)
    );
    assert(matchedEvents.length > 0, "No realtime delete event received for reelId");

    const channels = [...new Set(matchedEvents.map((e) => e.channel))];
    assert(channels.includes("reel/deleted"), "Missing channel reel/deleted");
    if (EXPECT_REELS_DELETE_CHANNEL) {
      assert(channels.includes("reels"), "Missing channel reels");
    }
    assert(
      matchedEvents.some((entry) => Number(entry?.payload?.reel?.id ?? 0) === reelId),
      "Delete payload missing reel.id compatibility field"
    );
    assert(
      matchedEvents.some((entry) => entry?.payload?.ui_hint?.auto_open === false),
      "Delete payload missing ui_hint.auto_open=false"
    );
    if (ownerId > 0) {
      let ringEvent = null;
      const ringStartedAt = Date.now();
      while (Date.now() - ringStartedAt < TIMEOUT_MS) {
        ringEvent =
          ringEvents.find(
            (entry) => entry.ts >= deleteStartedAt && toUserId(entry.payload) === ownerId
          ) ?? null;
        if (ringEvent) break;
        await new Promise((r) => setTimeout(r, 80));
      }
      assert(
        ringEvent,
        `No orbit/ring-updated event after delete for ownerId=${ownerId}`
      );
      assert(
        typeof ringEvent.payload?.has_orbit_ring === "boolean" ||
          typeof ringEvent.payload?.hasOrbitRing === "boolean",
        "orbit/ring-updated missing has_orbit_ring compatibility field"
      );
    }

    console.log(`[pass] realtime delete events received channels=${channels.join(",")}`);
    console.log("[pass] reel realtime delete is working");
  } finally {
    socket.removeAllListeners();
    socket.close();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
