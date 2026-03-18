#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
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

async function login(email, password, uuid) {
  assert(email, "Missing email");
  assert(password, `Missing password for ${email}`);

  const api = buildApi("");
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

async function main() {
  const owner = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const commenter = await login(
    COMMENTER_EMAIL,
    COMMENTER_PASSWORD,
    COMMENTER_LOGIN_UUID
  );

  assert(owner.userId !== commenter.userId, "owner and commenter must be different users");

  const apiOwner = buildApi(owner.token);
  const apiCommenter = buildApi(commenter.token);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] ownerId=${owner.userId} commenterId=${commenter.userId}`);

  const createResponse = await apiOwner.post("/reel", {
    description: "tmp orbit comment notification test",
    stream_url: "https://example.com/orbit-comment-notification.m3u8",
    thumbnail_url: "https://example.com/orbit-comment-notification.jpg",
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

  const marker = `orbit-comment-noti-${Date.now()}`;

  try {
    const commentResponse = await apiCommenter.post(`/reel/${reelId}/comments`, {
      comment: marker,
    });
    assert(
      commentResponse.status >= 200 && commentResponse.status < 300,
      `POST /reel/${reelId}/comments failed status=${commentResponse.status} body=${JSON.stringify(
        commentResponse.data
      )}`
    );

    const startedAt = Date.now();
    let found = null;

    while (Date.now() - startedAt < TIMEOUT_MS) {
      const notificationsResponse = await apiOwner.get("/notification");
      assert(
        notificationsResponse.status >= 200 && notificationsResponse.status < 300,
        `GET /notification failed status=${notificationsResponse.status} body=${JSON.stringify(
          notificationsResponse.data
        )}`
      );

      const notifications = notificationsResponse?.data?.body;
      const list = Array.isArray(notifications) ? notifications : [];

      found = list.find((item) => {
        const type = String(item?.type ?? "");
        const interactorId = Number(item?.interactorId || 0);
        const message = String(item?.message ?? "");
        return (
          type === "comment" &&
          interactorId === commenter.userId &&
          message.includes(marker.slice(0, 30))
        );
      });

      if (found) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    assert(found, "Orbit comment notification not found for owner");
    console.log("[pass] orbit comment notification delivered");
  } finally {
    await apiOwner.delete(`/reel/${reelId}`);
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
