#!/usr/bin/env node
"use strict";

const axios = require("axios");

const API_BASE_URL = String(
  process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1"
).trim();
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 15000);

const VIEWER_TOKEN = String(process.env.VIEWER_TOKEN || "").trim();
const OWNER_TOKEN = String(process.env.OWNER_TOKEN || "").trim();
const VIEWER_EMAIL = String(process.env.VIEWER_EMAIL || "").trim();
const VIEWER_PASSWORD = String(process.env.VIEWER_PASSWORD || "").trim();
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || "").trim();
const OWNER_PASSWORD = String(process.env.OWNER_PASSWORD || "").trim();
const VIEWER_LOGIN_UUID = String(process.env.VIEWER_LOGIN_UUID || "").trim();
const OWNER_LOGIN_UUID = String(process.env.OWNER_LOGIN_UUID || "").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeClient(token = "") {
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

function looksLikeJwt(token) {
  if (!token) return false;
  const parts = String(token).split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function pickToken(loginData) {
  return (
    loginData?.body?.user?.auth_token ||
    loginData?.body?.auth_token ||
    loginData?.body?.token ||
    loginData?.token ||
    ""
  );
}

function pickUserId(loginData) {
  const raw =
    loginData?.body?.user?.id ||
    loginData?.body?.id ||
    loginData?.user?.id ||
    0;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

async function loginWithEmail(email, password, uuid) {
  assert(email, "Missing email");
  assert(password, `Missing password for ${email}`);
  const api = makeClient();
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

  const token = String(pickToken(response.data)).trim();
  const userId = pickUserId(response.data);
  assert(looksLikeJwt(token), `Invalid token from login for ${email}`);
  assert(userId > 0, `Invalid user id from login for ${email}`);
  return { token, userId };
}

async function resolveAuth() {
  let viewerToken = VIEWER_TOKEN;
  let ownerToken = OWNER_TOKEN;
  let viewerId = 0;
  let ownerId = 0;

  if (!viewerToken) {
    const viewerLogin = await loginWithEmail(
      VIEWER_EMAIL,
      VIEWER_PASSWORD,
      VIEWER_LOGIN_UUID
    );
    viewerToken = viewerLogin.token;
    viewerId = viewerLogin.userId;
  }

  if (!ownerToken) {
    const ownerLogin = await loginWithEmail(
      OWNER_EMAIL,
      OWNER_PASSWORD,
      OWNER_LOGIN_UUID
    );
    ownerToken = ownerLogin.token;
    ownerId = ownerLogin.userId;
  }

  assert(looksLikeJwt(viewerToken), "VIEWER_TOKEN inválido");
  assert(looksLikeJwt(ownerToken), "OWNER_TOKEN inválido");

  // If ids were not obtained via login, resolve through /user/myData.
  if (!viewerId) {
    const apiViewer = makeClient(viewerToken);
    const myData = await apiViewer.get("/user/myData");
    viewerId = Number(myData?.data?.body?.user?.id || 0);
  }

  if (!ownerId) {
    const apiOwner = makeClient(ownerToken);
    const myData = await apiOwner.get("/user/myData");
    ownerId = Number(myData?.data?.body?.user?.id || 0);
  }

  assert(viewerId > 0, "No se pudo resolver viewerId");
  assert(ownerId > 0, "No se pudo resolver ownerId");
  assert(viewerId !== ownerId, "viewer y owner deben ser diferentes");

  return { viewerToken, ownerToken, viewerId, ownerId };
}

function findPostById(posts, postId) {
  const id = Number(postId);
  return (posts || []).find((post) => Number(post?.id) === id);
}

function readSavedFlag(post) {
  return Boolean(post?.is_saved);
}

function readSavedCount(post) {
  const value = Number(post?.saved_count ?? post?.savedCount ?? 0);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

async function getProfilePosts(apiViewer, ownerId) {
  const response = await apiViewer.get(`/user/one/${ownerId}`);
  assert(
    response.status >= 200 && response.status < 300,
    `GET /user/one/${ownerId} falló status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
  const posts = response?.data?.body?.user?.posts;
  assert(Array.isArray(posts), "user.posts no es un array");
  return posts;
}

async function savePost(apiViewer, postId) {
  const response = await apiViewer.post(`/saved/posts/${postId}`, {});
  assert(
    response.status >= 200 && response.status < 300,
    `save post falló status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
}

async function unsavePost(apiViewer, postId) {
  const response = await apiViewer.delete(`/saved/posts/${postId}`);
  assert(
    response.status >= 200 && response.status < 300,
    `unsave post falló status=${response.status} body=${JSON.stringify(
      response.data
    )}`
  );
}

async function main() {
  const { viewerToken, viewerId, ownerId } = await resolveAuth();
  const apiViewer = makeClient(viewerToken);

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] viewerId=${viewerId} ownerId=${ownerId}`);

  let posts = await getProfilePosts(apiViewer, ownerId);
  assert(posts.length > 0, "El owner no tiene posts para probar");

  const candidate = posts.find((post) => Number(post?.userId) === ownerId) || posts[0];
  const postId = Number(candidate?.id || 0);
  assert(postId > 0, "No se encontró postId válido para prueba");
  console.log(`[test] target postId=${postId}`);

  // Baseline in unsaved state
  await unsavePost(apiViewer, postId);
  posts = await getProfilePosts(apiViewer, ownerId);
  const baselinePost = findPostById(posts, postId);
  assert(baselinePost, "No se encontró el post en perfil (baseline)");
  const baselineSaved = readSavedFlag(baselinePost);
  const baselineCount = readSavedCount(baselinePost);
  assert(
    baselineSaved === false,
    `Esperado is_saved=false en baseline, llegó ${baselineSaved}`
  );
  console.log(
    `[pass] baseline profile post is_saved=false saved_count=${baselineCount}`
  );

  // Save and verify profile payload reflects change
  await savePost(apiViewer, postId);
  posts = await getProfilePosts(apiViewer, ownerId);
  const savedPost = findPostById(posts, postId);
  assert(savedPost, "No se encontró el post en perfil (saved)");
  const savedFlag = readSavedFlag(savedPost);
  const savedCount = readSavedCount(savedPost);
  assert(savedFlag === true, `Esperado is_saved=true tras guardar, llegó ${savedFlag}`);
  assert(
    savedCount >= baselineCount,
    `saved_count no válido: baseline=${baselineCount} now=${savedCount}`
  );
  console.log(
    `[pass] after save profile post is_saved=true saved_count=${savedCount}`
  );

  // Cleanup
  await unsavePost(apiViewer, postId);
  posts = await getProfilePosts(apiViewer, ownerId);
  const finalPost = findPostById(posts, postId);
  assert(finalPost, "No se encontró el post en perfil (final)");
  const finalSaved = readSavedFlag(finalPost);
  assert(finalSaved === false, `Esperado is_saved=false al final, llegó ${finalSaved}`);
  console.log("[pass] cleanup final state is_saved=false");

  console.log("[pass] profile saved-state persistence is working");
}

main().catch((error) => {
  console.error(`[fail] ${error?.message || error}`);
  process.exit(1);
});
