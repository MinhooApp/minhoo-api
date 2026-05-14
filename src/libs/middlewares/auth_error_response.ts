import { createHash } from "crypto";
import { Response } from "express";

export type AuthErrorCode =
  | "AUTH_TOKEN_REQUIRED"
  | "AUTH_TOKEN_EXPIRED"
  | "AUTH_TOKEN_INVALID"
  | "AUTH_SESSION_REVOKED"
  | "AUTH_BACKEND_UNAVAILABLE"
  | "AUTH_FORBIDDEN"
  | "AUTH_INTERNAL_ERROR";

/**
 * Explicit action hint for the mobile client.
 *
 * "refresh"  → try /auth/refresh with the stored refresh token; do NOT logout yet.
 * "retry"    → server/network issue; retry the same request; do NOT logout.
 * "login"    → no recoverable session; redirect to login screen.
 * "logout"   → session was explicitly revoked; clear local state and redirect.
 * "none"     → role/permission error; block this action only, keep session alive.
 */
export type AuthErrorAction = "refresh" | "retry" | "login" | "logout" | "none";

/**
 * Maps an error code to the recommended client action.
 *
 * AUTH_TOKEN_INVALID → "refresh" (not "login") because the access token may be
 * stale while the refresh token is still valid; try refresh before giving up.
 */
export const resolveAuthAction = (code: AuthErrorCode): AuthErrorAction => {
  switch (code) {
    case "AUTH_TOKEN_REQUIRED":      return "login";
    case "AUTH_TOKEN_EXPIRED":       return "refresh";
    case "AUTH_TOKEN_INVALID":       return "refresh";
    case "AUTH_SESSION_REVOKED":     return "logout";
    case "AUTH_BACKEND_UNAVAILABLE": return "retry";
    case "AUTH_FORBIDDEN":           return "none";
    case "AUTH_INTERNAL_ERROR":      return "retry";
    default:                         return "retry";
  }
};

const toText = (value: any): string => {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const first = value.find((item) => String(item ?? "").trim().length > 0);
    return String(first ?? "").trim();
  }
  return String(value).trim();
};

const pickFirstText = (...values: any[]): string => {
  for (const value of values) {
    const normalized = toText(value);
    if (normalized) return normalized;
  }
  return "";
};

const headerValue = (reqAny: any, name: string): string => {
  const headers = reqAny?.headers ?? {};
  const direct = headers?.[name];
  if (direct !== undefined) return toText(direct);
  const lower = headers?.[String(name).toLowerCase()];
  if (lower !== undefined) return toText(lower);
  const upper = headers?.[String(name).toUpperCase()];
  if (upper !== undefined) return toText(upper);
  return "";
};

const normalizePlatform = (raw: any): string => {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("android")) return "android";
  if (
    normalized.includes("ios") ||
    normalized.includes("iphone") ||
    normalized.includes("ipad")
  ) {
    return "ios";
  }
  if (normalized.includes("web") || normalized.includes("chrome") || normalized.includes("safari")) {
    return "web";
  }
  if (normalized.includes("mac")) return "macos";
  if (normalized.includes("windows") || normalized.includes("win")) return "windows";
  if (normalized.includes("linux")) return "linux";
  return normalized.slice(0, 32);
};

const inferPlatformFromUserAgent = (userAgentRaw: string): string => {
  const userAgent = String(userAgentRaw ?? "").trim().toLowerCase();
  if (!userAgent) return "unknown";
  if (userAgent.includes("android")) return "android";
  if (userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("ios")) {
    return "ios";
  }
  if (userAgent.includes("mac os")) return "macos";
  if (userAgent.includes("windows")) return "windows";
  if (userAgent.includes("linux")) return "linux";
  return "unknown";
};

const normalizeAppVersion = (raw: any): string => {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^v/, "");
  if (!normalized) return "unknown";
  return normalized.slice(0, 48);
};

const fingerprint = (raw: string, prefix: string): string => {
  if (!raw) return `${prefix}:unknown`;
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 12);
  return `${prefix}:${hash}`;
};

const isRetryableAuthError = (code: AuthErrorCode): boolean => {
  return code === "AUTH_TOKEN_EXPIRED" || code === "AUTH_BACKEND_UNAVAILABLE";
};

/**
 * Standard auth error envelope used by auth middlewares.
 * Keeps legacy header/messages fields for backward compatibility.
 *
 * @param reason  Optional sub-classification surfaced in the response body.
 *                Examples: "account_disabled", "token_rotated", "session_cap"
 *                Lets the mobile client display a precise message without
 *                changing the top-level error code.
 */
export const sendAuthError = (
  res: Response,
  status: number,
  code: AuthErrorCode,
  message: string,
  authenticated = false,
  reason?: string
) => {
  const retryable = isRetryableAuthError(code);
  const action = resolveAuthAction(code);

  try {
    res.setHeader("x-auth-error-code", code);
    res.setHeader("x-auth-error-retryable", retryable ? "1" : "0");
    res.setHeader("x-auth-action", action);
    if (reason) res.setHeader("x-auth-error-reason", reason);
  } catch (_error) {
    // ignore header write failures (e.g. headers already sent)
  }

  try {
    const reqAny: any = (res as any)?.req ?? {};
    const query: any = reqAny?.query ?? {};
    const body: any = reqAny?.body ?? {};
    const routePath = reqAny?.route?.path ? String(reqAny.route.path) : "";
    const baseUrl = reqAny?.baseUrl ? String(reqAny.baseUrl) : "";
    const route = routePath ? `${baseUrl}${routePath}` : String(reqAny?.originalUrl ?? "").split("?")[0];
    const userId = Number(reqAny?.userId ?? 0);
    const userAgent = pickFirstText(
      headerValue(reqAny, "user-agent"),
      headerValue(reqAny, "User-Agent")
    );

    const appVersion = normalizeAppVersion(
      pickFirstText(
        headerValue(reqAny, "x-app-version"),
        headerValue(reqAny, "x-client-version"),
        headerValue(reqAny, "x-app-ver"),
        (query as any)?.app_version,
        (query as any)?.appVersion,
        (body as any)?.app_version,
        (body as any)?.appVersion
      )
    );

    const appBuild = normalizeAppVersion(
      pickFirstText(
        headerValue(reqAny, "x-app-build"),
        headerValue(reqAny, "x-build-number"),
        headerValue(reqAny, "x-build"),
        (query as any)?.app_build,
        (query as any)?.appBuild,
        (body as any)?.app_build,
        (body as any)?.appBuild
      )
    );

    const platform = normalizePlatform(
      pickFirstText(
        headerValue(reqAny, "x-platform"),
        headerValue(reqAny, "x-device-platform"),
        headerValue(reqAny, "sec-ch-ua-platform")
      ) || inferPlatformFromUserAgent(userAgent)
    );

    const rawDeviceIdentity = pickFirstText(
      headerValue(reqAny, "x-device-id"),
      headerValue(reqAny, "x-device-uuid"),
      headerValue(reqAny, "x-device-token"),
      headerValue(reqAny, "x-fcm-token"),
      (query as any)?.device_id,
      (query as any)?.deviceId,
      (query as any)?.uuid,
      (body as any)?.device_id,
      (body as any)?.deviceId,
      (body as any)?.uuid
    );

    const rawSessionKey = pickFirstText(
      headerValue(reqAny, "x-session-key"),
      (query as any)?.session_key,
      (query as any)?.sessionKey
    );

    const deviceFp = fingerprint(rawDeviceIdentity, "dev");
    const sessionFp = fingerprint(rawSessionKey, "sess");

    console.warn(
      `[auth-error] ${JSON.stringify({
        status,
        code,
        action,
        retryable,
        reason: reason || undefined,
        route: route || "unknown",
        method: String(reqAny?.method ?? "").toUpperCase(),
        authenticated,
        user_id: Number.isFinite(userId) && userId > 0 ? Math.floor(userId) : null,
        app_version: appVersion,
        app_build: appBuild,
        platform,
        device_fp: deviceFp,
        session_fp: sessionFp,
      })}`
    );
  } catch (_error) {
    // ignore log serialization failures
  }

  return res.status(status).json({
    success: false,
    code,
    action,
    message,
    retryable,
    ...(reason ? { reason } : {}),
    header: { success: false, authenticated },
    messages: [message],
  });
};
