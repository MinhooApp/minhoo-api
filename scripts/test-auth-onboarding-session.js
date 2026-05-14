#!/usr/bin/env node
"use strict";

/* eslint-disable no-console */
const path = require("path");
const axios = require("axios");
const dotenv = require("dotenv");
const { applyFileBackedSecrets } = require("./_utils/apply-file-backed-secrets");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
applyFileBackedSecrets(process.env, {
  forceOverride: false,
  baseDir: path.resolve(__dirname, ".."),
});

const API_BASE_URL = String(process.env.API_BASE_URL || "http://127.0.0.1:3000/api/v1")
  .trim()
  .replace(/\/+$/, "");
const TIMEOUT_MS = Math.max(5000, Number(process.env.TEST_TIMEOUT_MS || 20000) || 20000);
const SIGNUP_PASSWORD = String(process.env.ONBOARDING_SMOKE_PASSWORD || "SmokePass#2026").trim();

const assert2xx = (step, response) => {
  const status = Number(response?.status ?? 0);
  if (status >= 200 && status < 300) return;
  const body = JSON.stringify(response?.data ?? {});
  throw new Error(`[${step}] expected 2xx, got ${status}. body=${body}`);
};

const normalizeBearer = (tokenRaw) => {
  const token = String(tokenRaw ?? "").trim();
  if (!token) return "";
  if (/^bearer\s+/i.test(token)) return token;
  return `Bearer ${token}`;
};

const pickAccessToken = (payload) => {
  const body = payload?.body ?? {};
  const user = body?.user ?? {};
  const candidates = [
    user?.auth_token,
    user?.authToken,
    user?.access_token,
    user?.accessToken,
    user?.token,
    body?.auth_token,
    body?.authToken,
    body?.access_token,
    body?.accessToken,
    body?.token,
    payload?.auth_token,
    payload?.authToken,
    payload?.access_token,
    payload?.accessToken,
    payload?.token,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
};

const pickCategoryId = (payload) => {
  const categories = payload?.body?.categories;
  if (!Array.isArray(categories)) return null;
  for (const category of categories) {
    const id = Number(category?.id);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
};

const createAxios = (authorization) =>
  axios.create({
    baseURL: API_BASE_URL,
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: normalizeBearer(authorization) } : {}),
    },
  });

const rand = (length = 12) => {
  const source = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  while (value.length < length) {
    value += source[Math.floor(Math.random() * source.length)];
  }
  return value;
};

const buildUuid = (prefix) => `${prefix}-${Date.now()}-${rand(16)}-token`;

const buildPhone = () => {
  const tail = String(Math.floor(Math.random() * 10 ** 8)).padStart(8, "0");
  return `5${tail}`;
};

const main = async () => {
  const api = createAxios();
  const runId = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const signupUuid = buildUuid("signup");
  const postUuid = buildUuid("post");
  const putUuid = buildUuid("put");
  const patchUuid = buildUuid("patch");
  const email = `ci.onboarding.${runId}@example.test`;
  const phone = buildPhone();

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] email=${email}`);

  const categoriesRes = await api.get("/category");
  assert2xx("category.list", categoriesRes);
  const categoryId = pickCategoryId(categoriesRes.data);
  console.log(`[test] categoryId=${categoryId ?? "none"}`);

  const signupBody = {
    email,
    password: SIGNUP_PASSWORD,
    confirm_password: SIGNUP_PASSWORD,
    uuid: signupUuid,
    name: "Smoke",
    last_name: "Onboarding",
    categories: categoryId ? [categoryId] : [],
    app_language: "en",
  };

  const signUpRes = await api.post("/auth/image", signupBody);
  assert2xx("auth.signup.image", signUpRes);

  const token = pickAccessToken(signUpRes.data);
  if (!token) {
    throw new Error(
      `[auth.signup.image] missing access token. body=${JSON.stringify(signUpRes.data ?? {})}`
    );
  }

  const authApi = createAxios(token);
  const authHeader = normalizeBearer(token);
  const workerPayload = {
    name: "Smoke",
    last_name: "Onboarding",
    dialing_code: "+1",
    iso_code: "US",
    phone,
    about: "onboarding smoke test",
  };
  if (categoryId) workerPayload.skills = [categoryId];

  const visibilityRes = await authApi.put("/user/visibility", { show_email: true });
  assert2xx("user.visibility", visibilityRes);

  const devicePostRes = await authApi.post("/auth/device-token", { uuid: postUuid });
  assert2xx("auth.device-token.post", devicePostRes);

  const devicePutRes = await authApi.put("/auth/device-token", { uuid: putUuid });
  assert2xx("auth.device-token.put", devicePutRes);

  const devicePatchRes = await authApi.patch("/auth/device-token", { uuid: patchUuid });
  assert2xx("auth.device-token.patch", devicePatchRes);

  const workerCreateRes = await authApi.post("/worker", workerPayload);
  assert2xx("worker.create", workerCreateRes);

  const workerProfilePayload = {
    first_name: "Smoke",
    last_name: "Onboarding",
    dialing_code: "+1",
    iso_code: "US",
    phone,
    about: "onboarding smoke profile update",
  };
  if (categoryId) workerProfilePayload.skills = [categoryId];
  const workerProfileRes = await authApi.put("/worker/profile", workerProfilePayload);
  assert2xx("worker.profile", workerProfileRes);

  const sessionValidateRes = await authApi.get("/auth/session/validate");
  assert2xx("auth.session.validate", sessionValidateRes);

  const myDataRes = await authApi.get("/user/myData");
  assert2xx("user.myData", myDataRes);

  const myDataUserId = Number(myDataRes?.data?.body?.user?.id ?? 0) || null;
  console.log(
    JSON.stringify(
      {
        pass: true,
        run_id: runId,
        signup_email: email,
        user_id: myDataUserId,
        category_id: categoryId,
        auth_header_prefix: authHeader.slice(0, 20),
        checks: [
          "auth.signup.image",
          "user.visibility",
          "auth.device-token.post",
          "auth.device-token.put",
          "auth.device-token.patch",
          "worker.create",
          "worker.profile",
          "auth.session.validate",
          "user.myData",
        ],
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  const message = String(error?.stack || error?.message || error);
  console.error(message);
  process.exit(1);
});

