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

const VIEWER_EMAIL = String(
  process.env.VIEWER_EMAIL || "brainstorm.good@gmail.com"
).trim();
const VIEWER_PASSWORD = String(process.env.VIEWER_PASSWORD || "Eder2013#").trim();
const VIEWER_LOGIN_UUID = String(process.env.VIEWER_LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const api = makeApi("");
  const payload = { email, password };
  if (String(uuid || "").trim().length >= 20) {
    payload.uuid = String(uuid).trim();
  }

  const response = await api.post("/auth/login", payload);
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

function extractIds(responseData) {
  return new Set(
    (responseData?.body?.reels ?? [])
      .map((row) => Number(row?.id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
}

async function getRelationship(api, targetUserId) {
  const response = await api.get(`/user/${targetUserId}/relationship`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /user/${targetUserId}/relationship failed status=${response.status}`
  );
  return !!response.data?.body?.isFollowing;
}

async function main() {
  const owner = await login(OWNER_EMAIL, OWNER_PASSWORD, OWNER_LOGIN_UUID);
  const viewer = await login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID);
  assert(owner.userId !== viewer.userId, "owner and viewer must be different users");

  const apiOwner = makeApi(owner.token);
  const apiViewer = makeApi(viewer.token);
  const apiGuest = makeApi("");

  const createdReelIds = [];
  let initialIsFollowing = false;

  try {
    initialIsFollowing = await getRelationship(apiViewer, owner.userId);
    if (initialIsFollowing) {
      const cleanup = await apiViewer.delete(`/user/${owner.userId}/follow`);
      assert(
        cleanup.status >= 200 && cleanup.status < 300,
        `Initial unfollow cleanup failed status=${cleanup.status}`
      );
    }

    const definitions = [
      { visibility: "public", description: `profile-route-public-${Date.now()}` },
      { visibility: "followers", description: `profile-route-followers-${Date.now()}` },
      { visibility: "private", description: `profile-route-private-${Date.now()}` },
    ];

    for (const definition of definitions) {
      const createResponse = await apiOwner.post("/reel", {
        description: definition.description,
        stream_url: `https://example.com/${definition.description}.m3u8`,
        thumbnail_url: `https://example.com/${definition.description}.jpg`,
        visibility: definition.visibility,
        allow_download: false,
      });
      assert(
        createResponse.status >= 200 && createResponse.status < 300,
        `POST /reel failed for ${definition.visibility} status=${createResponse.status} body=${JSON.stringify(
          createResponse.data
        )}`
      );

      const reelId = Number(createResponse?.data?.body?.reel?.id || 0);
      assert(reelId > 0, `Invalid reel id for ${definition.visibility}`);
      createdReelIds.push({ reelId, visibility: definition.visibility });
    }

    const ownerResponse = await apiOwner.get(`/reel/user/${owner.userId}`);
    assert(
      ownerResponse.status >= 200 && ownerResponse.status < 300,
      `Owner GET /reel/user/${owner.userId} failed status=${ownerResponse.status}`
    );
    const ownerIds = extractIds(ownerResponse.data);
    createdReelIds.forEach(({ reelId }) => {
      assert(ownerIds.has(reelId), `Owner response missing reelId=${reelId}`);
    });

    const guestResponse = await apiGuest.get(`/reel/user/${owner.userId}`);
    assert(
      guestResponse.status >= 200 && guestResponse.status < 300,
      `Guest GET /reel/user/${owner.userId} failed status=${guestResponse.status}`
    );
    const guestIds = extractIds(guestResponse.data);
    const publicId = createdReelIds.find((row) => row.visibility === "public").reelId;
    const followersId = createdReelIds.find((row) => row.visibility === "followers").reelId;
    const privateId = createdReelIds.find((row) => row.visibility === "private").reelId;
    assert(guestIds.has(publicId), "Guest response missing public orbit");
    assert(!guestIds.has(followersId), "Guest should not receive followers orbit");
    assert(!guestIds.has(privateId), "Guest should not receive private orbit");

    const viewerBeforeFollow = await apiViewer.get(`/reel/user/${owner.userId}`);
    assert(
      viewerBeforeFollow.status >= 200 && viewerBeforeFollow.status < 300,
      `Viewer pre-follow GET /reel/user/${owner.userId} failed status=${viewerBeforeFollow.status}`
    );
    const viewerBeforeIds = extractIds(viewerBeforeFollow.data);
    assert(viewerBeforeIds.has(publicId), "Viewer pre-follow missing public orbit");
    assert(!viewerBeforeIds.has(followersId), "Viewer pre-follow should not receive followers orbit");
    assert(!viewerBeforeIds.has(privateId), "Viewer pre-follow should not receive private orbit");

    const followResponse = await apiViewer.post(`/user/${owner.userId}/follow`);
    assert(
      followResponse.status >= 200 && followResponse.status < 300,
      `POST /user/${owner.userId}/follow failed status=${followResponse.status}`
    );

    const viewerAfterFollow = await apiViewer.get(`/reel/user/${owner.userId}`);
    assert(
      viewerAfterFollow.status >= 200 && viewerAfterFollow.status < 300,
      `Viewer post-follow GET /reel/user/${owner.userId} failed status=${viewerAfterFollow.status}`
    );
    const viewerAfterIds = extractIds(viewerAfterFollow.data);
    assert(viewerAfterIds.has(publicId), "Viewer post-follow missing public orbit");
    assert(viewerAfterIds.has(followersId), "Viewer post-follow missing followers orbit");
    assert(!viewerAfterIds.has(privateId), "Viewer post-follow should not receive private orbit");

    console.log("[pass] owner can view own public/followers/private orbits");
    console.log("[pass] guest and non-follower only receive public orbits");
    console.log("[pass] follower receives public and followers orbits");
    console.log("[pass] profile orbit route is working");
  } finally {
    try {
      const currentIsFollowing = await getRelationship(apiViewer, owner.userId).catch(
        () => false
      );
      if (initialIsFollowing && !currentIsFollowing) {
        await apiViewer.post(`/user/${owner.userId}/follow`);
      }
      if (!initialIsFollowing && currentIsFollowing) {
        await apiViewer.delete(`/user/${owner.userId}/follow`);
      }
    } catch (error) {
      console.error("[warn] failed to restore follow state", error);
    }

    for (const row of createdReelIds.reverse()) {
      try {
        await apiOwner.delete(`/reel/${row.reelId}`);
      } catch (error) {
        console.error(`[warn] failed to delete reelId=${row.reelId}`, error);
      }
    }
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
