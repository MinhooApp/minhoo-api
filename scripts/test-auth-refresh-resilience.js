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
const EXPECT_REFRESH_GRACE_SECONDS = Math.max(
  0,
  Number(process.env.AUTH_REFRESH_ROTATION_GRACE_SECONDS ?? 10 * 60) || 10 * 60
);
const AUTH_ALLOW_ACCESS_TOKEN_REFRESH = String(
  process.env.AUTH_ALLOW_ACCESS_TOKEN_REFRESH ?? "0"
).trim() === "1";

const assert2xx = (step, response) => {
  const status = Number(response?.status ?? 0);
  if (status >= 200 && status < 300) return;
  throw new Error(`[${step}] expected 2xx, got ${status}. body=${JSON.stringify(response?.data ?? {})}`);
};

const normalizeBearer = (tokenRaw) => {
  const token = String(tokenRaw ?? "").trim();
  if (!token) return "";
  if (/^bearer\s+/i.test(token)) return token;
  return `Bearer ${token}`;
};

const readToken = (source, keys) => {
  for (const key of keys) {
    const value = String(source?.[key] ?? "").trim();
    if (!value) continue;
    if (/^bearer\s+/i.test(value)) return value.replace(/^bearer\s+/i, "");
    return value;
  }
  return "";
};

const pickAccessToken = (payload) => {
  const body = payload?.body ?? {};
  const user = body?.user ?? {};
  return readToken(
    { ...payload, ...body, ...user },
    [
      "access_token",
      "accessToken",
      "auth_token",
      "authToken",
      "token",
    ]
  );
};

const pickRefreshToken = (payload) => {
  const body = payload?.body ?? {};
  const user = body?.user ?? {};
  return readToken(
    { ...payload, ...body, ...user },
    ["refresh_token", "refreshToken"]
  );
};

const extractAuthCode = (response) => {
  const code = String(response?.data?.code || "").trim();
  if (code) return code;
  return String(response?.headers?.["x-auth-error-code"] || "").trim();
};

const expectAuthError = (step, response, expectedCodes) => {
  const status = Number(response?.status ?? 0);
  const code = extractAuthCode(response);
  const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  if (status !== 401) {
    throw new Error(`[${step}] expected status 401, got ${status}. body=${JSON.stringify(response?.data ?? {})}`);
  }
  if (!allowed.includes(code)) {
    throw new Error(
      `[${step}] expected auth code ${allowed.join("|")}, got ${code || "<empty>"}. body=${JSON.stringify(
        response?.data ?? {}
      )}`
    );
  }
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

const buildUuid = (prefix) => `${prefix}-${Date.now()}-${rand(12)}`;

const pickCategoryId = (payload) => {
  const categories = payload?.body?.categories;
  if (!Array.isArray(categories)) return null;
  for (const category of categories) {
    const id = Number(category?.id);
    if (Number.isFinite(id) && id > 0) return id;
  }
  return null;
};

const main = async () => {
  const api = createAxios();
  const runId = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const email = `ci.refresh.${runId}@example.test`;
  const signupUuid = buildUuid("signup");

  console.log(`[test] API_BASE_URL=${API_BASE_URL}`);
  console.log(`[test] email=${email}`);

  const refreshMissingRes = await api.post("/auth/refresh", {});
  expectAuthError("auth.refresh.missing", refreshMissingRes, "AUTH_TOKEN_INVALID");

  const refreshInvalidRes = await api.post("/auth/refresh", { refresh_token: "invalid.refresh.token" });
  expectAuthError("auth.refresh.invalid", refreshInvalidRes, "AUTH_TOKEN_INVALID");

  const categoriesRes = await api.get("/category");
  assert2xx("category.list", categoriesRes);
  const categoryId = pickCategoryId(categoriesRes.data);

  const signupBody = {
    email,
    password: SIGNUP_PASSWORD,
    confirm_password: SIGNUP_PASSWORD,
    uuid: signupUuid,
    name: "Smoke",
    last_name: "Refresh",
    categories: categoryId ? [categoryId] : [],
    app_language: "en",
  };

  const signUpRes = await api.post("/auth/image", signupBody);
  assert2xx("auth.signup.image", signUpRes);

  const accessToken1 = pickAccessToken(signUpRes.data);
  const refreshToken1 = pickRefreshToken(signUpRes.data);
  if (!accessToken1) {
    throw new Error(`[auth.signup.image] missing access token. body=${JSON.stringify(signUpRes.data ?? {})}`);
  }
  if (!refreshToken1) {
    throw new Error(`[auth.signup.image] missing refresh token. body=${JSON.stringify(signUpRes.data ?? {})}`);
  }

  const refreshRes1 = await api.post("/auth/refresh", {
    refresh_token: refreshToken1,
    uuid: buildUuid("refresh-1"),
  });
  assert2xx("auth.refresh.first", refreshRes1);

  const accessToken2 = pickAccessToken(refreshRes1.data);
  const refreshToken2 = pickRefreshToken(refreshRes1.data);
  if (!accessToken2 || !refreshToken2) {
    throw new Error(`[auth.refresh.first] missing tokens. body=${JSON.stringify(refreshRes1.data ?? {})}`);
  }

  let latestAccessToken = accessToken2;
  let graceRefreshResult = "skipped";

  const refreshResOldToken = await api.post("/auth/refresh", {
    refresh_token: refreshToken1,
    uuid: buildUuid("refresh-old"),
  });

  if (EXPECT_REFRESH_GRACE_SECONDS > 0) {
    assert2xx("auth.refresh.old-token.grace", refreshResOldToken);
    const accessToken3 = pickAccessToken(refreshResOldToken.data);
    if (accessToken3) latestAccessToken = accessToken3;
    graceRefreshResult = "accepted";
  } else {
    expectAuthError("auth.refresh.old-token.no-grace", refreshResOldToken, "AUTH_SESSION_REVOKED");
    graceRefreshResult = "revoked";
  }

  const authApi = createAxios(latestAccessToken);
  const sessionValidateRes = await authApi.get("/auth/session/validate");
  assert2xx("auth.session.validate", sessionValidateRes);

  const deviceTokenRes = await authApi.post("/auth/device-token", {
    uuid: buildUuid("device"),
  });
  assert2xx("auth.device-token.post", deviceTokenRes);

  const refreshWithAccessRes = await api.post("/auth/refresh", {
    refresh_token: latestAccessToken,
  });

  if (AUTH_ALLOW_ACCESS_TOKEN_REFRESH) {
    assert2xx("auth.refresh.with-access-token.allowed", refreshWithAccessRes);
  } else {
    expectAuthError(
      "auth.refresh.with-access-token.disallowed",
      refreshWithAccessRes,
      "AUTH_TOKEN_INVALID"
    );
  }

  console.log(
    JSON.stringify(
      {
        pass: true,
        run_id: runId,
        email,
        checks: [
          "auth.refresh.missing",
          "auth.refresh.invalid",
          "auth.signup.image",
          "auth.refresh.first",
          EXPECT_REFRESH_GRACE_SECONDS > 0
            ? "auth.refresh.old-token.grace"
            : "auth.refresh.old-token.no-grace",
          "auth.session.validate",
          "auth.device-token.post",
          AUTH_ALLOW_ACCESS_TOKEN_REFRESH
            ? "auth.refresh.with-access-token.allowed"
            : "auth.refresh.with-access-token.disallowed",
        ],
        refresh_grace_seconds: EXPECT_REFRESH_GRACE_SECONDS,
        grace_old_token_result: graceRefreshResult,
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
