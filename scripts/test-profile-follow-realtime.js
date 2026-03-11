#!/usr/bin/env node
"use strict";

const axios = require("axios");
const { io } = require("socket.io-client");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const SOCKET_URL = String(process.env.SOCKET_URL || "http://127.0.0.1:3000").trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 20000);

const TARGET_EMAIL = String(process.env.TARGET_EMAIL || "info@minhoo.app").trim();
const TARGET_PASSWORD = String(process.env.TARGET_PASSWORD || "Eder2010#").trim();
const TARGET_LOGIN_UUID = String(process.env.TARGET_LOGIN_UUID || "").trim();

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
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function normalizeInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function normalizeUserPayload(entry) {
  const payload = entry?.payload ?? {};
  return {
    channel: entry?.channel ?? "",
    userId: normalizeInt(payload.userId ?? payload.user_id ?? payload.id),
    followersCount: normalizeInt(
      payload.followersCount ?? payload.followers_count ?? payload.counts?.followersCount
    ),
    followingCount: normalizeInt(
      payload.followingCount ??
        payload.followingsCount ??
        payload.following_count ??
        payload.followings_count ??
        payload.counts?.followingCount
    ),
    action: String(payload.action ?? payload.type ?? ""),
  };
}

function attachUserListeners(socket, bucket, userId) {
  const channels = ["user:updated", "user/updated", `user/${userId}`];
  for (const channel of channels) {
    socket.on(channel, (payload) => {
      bucket.push({ channel, payload, receivedAt: Date.now() });
    });
  }
}

async function fetchProfileCounts(api, targetUserId) {
  const [profileResponse, myDataResponse] = await Promise.all([
    api.get(`/user/one/${targetUserId}`),
    api.get("/user/myData"),
  ]);

  assert(
    profileResponse.status >= 200 && profileResponse.status < 300,
    `GET /user/one/${targetUserId} failed status=${profileResponse.status}`
  );
  assert(
    myDataResponse.status >= 200 && myDataResponse.status < 300,
    `GET /user/myData failed status=${myDataResponse.status}`
  );

  const profileBody = profileResponse.data?.body ?? {};
  const myDataBody = myDataResponse.data?.body ?? {};
  const profileUser = profileBody.user ?? {};
  const viewerUser = myDataBody.user ?? {};

  return {
    target: {
      followersCount: normalizeInt(
        profileBody.followersCount ??
          profileBody.counts?.followersCount ??
          profileUser.followersCount ??
          profileUser.followers_count
      ),
      followingCount: normalizeInt(
        profileBody.followingCount ??
          profileBody.counts?.followingCount ??
          profileUser.followingCount ??
          profileUser.followingsCount ??
          profileUser.followings_count
      ),
    },
    viewer: {
      followersCount: normalizeInt(
        myDataBody.followersCount ??
          myDataBody.counts?.followersCount ??
          viewerUser.followersCount ??
          viewerUser.followers_count
      ),
      followingCount: normalizeInt(
        myDataBody.followingCount ??
          myDataBody.counts?.followingCount ??
          viewerUser.followingCount ??
          viewerUser.followingsCount ??
          viewerUser.followings_count
      ),
    },
  };
}

async function getRelationship(api, targetUserId) {
  const response = await api.get(`/user/${targetUserId}/relationship`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /user/${targetUserId}/relationship failed status=${response.status}`
  );

  return !!response.data?.body?.isFollowing;
}

async function waitForCounts(events, expectations, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const normalized = events.map(normalizeUserPayload);
    const matched = expectations.every((expected) =>
      normalized.some(
        (entry) =>
          entry.userId === expected.userId &&
          entry.followersCount === expected.followersCount &&
          entry.followingCount === expected.followingCount
      )
    );

    if (matched) {
      return normalized;
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  const snapshot = events.map(normalizeUserPayload);
  throw new Error(
    `Timed out waiting for realtime counts. expectations=${JSON.stringify(
      expectations
    )} events=${JSON.stringify(snapshot)}`
  );
}

async function main() {
  const target = await login(TARGET_EMAIL, TARGET_PASSWORD, TARGET_LOGIN_UUID);
  const viewer = await login(VIEWER_EMAIL, VIEWER_PASSWORD, VIEWER_LOGIN_UUID);
  assert(target.userId !== viewer.userId, "target and viewer must be different users");

  const apiTarget = makeApi(target.token);
  const apiViewer = makeApi(viewer.token);

  const viewerSocketEvents = [];
  const targetSocketEvents = [];
  const viewerSocket = io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    timeout: TIMEOUT_MS,
    auth: { token: viewer.token },
    query: { token: viewer.token },
  });
  const targetSocket = io(SOCKET_URL, {
    transports: ["websocket", "polling"],
    timeout: TIMEOUT_MS,
    auth: { token: target.token },
    query: { token: target.token },
  });

  let initialIsFollowing = false;

  try {
    await Promise.all([
      waitForConnect(viewerSocket, TIMEOUT_MS),
      waitForConnect(targetSocket, TIMEOUT_MS),
    ]);
    attachUserListeners(viewerSocket, viewerSocketEvents, viewer.userId);
    attachUserListeners(targetSocket, targetSocketEvents, target.userId);

    initialIsFollowing = await getRelationship(apiViewer, target.userId);
    if (initialIsFollowing) {
      const normalizeResponse = await apiViewer.delete(`/user/${target.userId}/follow`);
      assert(
        normalizeResponse.status >= 200 && normalizeResponse.status < 300,
        `Initial cleanup unfollow failed status=${normalizeResponse.status}`
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    viewerSocketEvents.length = 0;
    targetSocketEvents.length = 0;

    const baselineCounts = await fetchProfileCounts(apiViewer, target.userId);
    console.log(
      `[test] baseline targetFollowers=${baselineCounts.target.followersCount} viewerFollowing=${baselineCounts.viewer.followingCount}`
    );

    const followResponse = await apiViewer.post(`/user/${target.userId}/follow`);
    assert(
      followResponse.status >= 200 && followResponse.status < 300,
      `POST /user/${target.userId}/follow failed status=${followResponse.status} body=${JSON.stringify(
        followResponse.data
      )}`
    );

    const afterFollowCounts = await fetchProfileCounts(apiViewer, target.userId);
    const followExpectations = [
      {
        userId: target.userId,
        followersCount: afterFollowCounts.target.followersCount,
        followingCount: afterFollowCounts.target.followingCount,
      },
      {
        userId: viewer.userId,
        followersCount: afterFollowCounts.viewer.followersCount,
        followingCount: afterFollowCounts.viewer.followingCount,
      },
    ];

    await Promise.all([
      waitForCounts(viewerSocketEvents, followExpectations, TIMEOUT_MS),
      waitForCounts(targetSocketEvents, followExpectations, TIMEOUT_MS),
    ]);

    console.log(
      `[pass] follow realtime counts targetFollowers=${afterFollowCounts.target.followersCount} viewerFollowing=${afterFollowCounts.viewer.followingCount}`
    );

    viewerSocketEvents.length = 0;
    targetSocketEvents.length = 0;

    const unfollowResponse = await apiViewer.delete(`/user/${target.userId}/follow`);
    assert(
      unfollowResponse.status >= 200 && unfollowResponse.status < 300,
      `DELETE /user/${target.userId}/follow failed status=${unfollowResponse.status} body=${JSON.stringify(
        unfollowResponse.data
      )}`
    );

    const afterUnfollowCounts = await fetchProfileCounts(apiViewer, target.userId);
    const unfollowExpectations = [
      {
        userId: target.userId,
        followersCount: afterUnfollowCounts.target.followersCount,
        followingCount: afterUnfollowCounts.target.followingCount,
      },
      {
        userId: viewer.userId,
        followersCount: afterUnfollowCounts.viewer.followersCount,
        followingCount: afterUnfollowCounts.viewer.followingCount,
      },
    ];

    await Promise.all([
      waitForCounts(viewerSocketEvents, unfollowExpectations, TIMEOUT_MS),
      waitForCounts(targetSocketEvents, unfollowExpectations, TIMEOUT_MS),
    ]);

    console.log(
      `[pass] unfollow realtime counts targetFollowers=${afterUnfollowCounts.target.followersCount} viewerFollowing=${afterUnfollowCounts.viewer.followingCount}`
    );
    console.log("[pass] profile follow/following realtime is working");
  } finally {
    try {
      const currentIsFollowing = await getRelationship(apiViewer, target.userId).catch(
        () => false
      );
      if (initialIsFollowing && !currentIsFollowing) {
        await apiViewer.post(`/user/${target.userId}/follow`);
      }
      if (!initialIsFollowing && currentIsFollowing) {
        await apiViewer.delete(`/user/${target.userId}/follow`);
      }
    } catch (error) {
      console.error("[warn] failed to restore initial follow state", error);
    }

    viewerSocket.removeAllListeners();
    targetSocket.removeAllListeners();
    viewerSocket.close();
    targetSocket.close();
  }
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
