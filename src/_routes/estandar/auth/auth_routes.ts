import Router from "express";
import jwt from "jsonwebtoken";
import User from "../../../_models/user/user";
import {
  validateEmail,
  verifyEmailCode,
  signUp,
  login,
  refreshToken,
  logout,
  logoutDevice,
  saveDeviceToken,
  requestRestorePassword,
  validateRestorePassword,
  restorePassword,
  validatePhone,
  changePass,
  validateSesion,
} from "../../../useCases/auth/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
import { sendAuthError } from "../../../libs/middlewares/auth_error_response";
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
import { createDistributedRateLimiter } from "../../../libs/security/redis_rate_limiter";
import { writeSecurityAuditFromRequest } from "../../../libs/security/security_audit_log";

const router = Router();
router.use((_req: any, res: any, next: any) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  return next();
});

const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const normalizeLimiterIdentityValue = (value: any) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 120);

const buildAuthIdentityKey = (req: any, fields: string[]) => {
  const ip = String(req?.ip ?? req?.socket?.remoteAddress ?? "unknown")
    .trim()
    .toLowerCase();
  const body = (req?.body ?? {}) as Record<string, any>;
  const parts = fields
    .map((field) => normalizeLimiterIdentityValue(body[field]))
    .filter(Boolean);
  if (!parts.length) return ip || "unknown";
  return `${ip || "unknown"}:${parts.join("|")}`;
};

const AUTH_RATE_WINDOW_MS = parsePositiveInt(
  process.env.AUTH_RATE_WINDOW_MS,
  60_000
);
const AUTH_RATE_BLOCK_MS = parsePositiveInt(
  process.env.AUTH_RATE_BLOCK_MS,
  10 * 60_000,
  0
);
const AUTH_RATE_MAX_ENTRIES = parsePositiveInt(
  process.env.AUTH_RATE_MAX_ENTRIES,
  25_000,
  500
);

const buildAuthLimiter = (
  keyPrefix: string,
  maxValue: any,
  fallbackMax: number,
  message: string,
  keyGenerator?: (req: any) => string
) =>
  createDistributedRateLimiter({
    windowMs: AUTH_RATE_WINDOW_MS,
    max: parsePositiveInt(maxValue, fallbackMax),
    blockDurationMs: AUTH_RATE_BLOCK_MS,
    maxEntries: AUTH_RATE_MAX_ENTRIES,
    keyPrefix,
    message,
    keyGenerator,
    onLimit: (context) => {
      writeSecurityAuditFromRequest(context.req, {
        event: "auth.rate_limited",
        level: "warn",
        actorUserId: Number((context.req as any)?.userId ?? 0) || null,
        success: false,
        reason: "rate_limit",
        meta: {
          scope: keyPrefix,
          hits: context.hits,
          limit: context.limit,
          retryAfterSeconds: context.retryAfterSeconds,
        },
      });
    },
  });

const validateEmailLimiter = buildAuthLimiter(
  "auth:validate_email",
  process.env.AUTH_RATE_MAX_VALIDATE_EMAIL,
  25,
  "too many email validation requests, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone"])
);
const verifyEmailLimiter = buildAuthLimiter(
  "auth:verify_email",
  process.env.AUTH_RATE_MAX_VERIFY_EMAIL,
  20,
  "too many verification requests, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone"])
);
const signUpLimiter = buildAuthLimiter(
  "auth:signup",
  process.env.AUTH_RATE_MAX_SIGNUP,
  8,
  "too many sign up attempts, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone", "username"])
);
const loginLimiter = buildAuthLimiter(
  "auth:login",
  process.env.AUTH_RATE_MAX_LOGIN,
  8,
  "too many login attempts, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone", "username"])
);
const refreshLimiter = buildAuthLimiter(
  "auth:refresh",
  process.env.AUTH_RATE_MAX_REFRESH,
  50,
  "too many refresh attempts, try later"
);
const restoreRequestLimiter = buildAuthLimiter(
  "auth:restore_request",
  process.env.AUTH_RATE_MAX_RESTORE_REQUEST,
  6,
  "too many password restore requests, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone"])
);
const restoreFlowLimiter = buildAuthLimiter(
  "auth:restore_flow",
  process.env.AUTH_RATE_MAX_RESTORE_FLOW,
  12,
  "too many password restore attempts, try later",
  (req) => buildAuthIdentityKey(req, ["email", "phone"])
);

/**
 * Middleware: antes del login revisa si el usuario está deshabilitado
 * (bloqueado por el admin). Si está disabled, NO deja entrar.
 */
const checkDisabledBeforeLogin = async (req: any, res: any, next: any) => {
  try {
    const { email, phone } = req.body;

    // Si no vienen credenciales, dejamos que el controlador maneje el error
    if (!email && !phone) {
      return next();
    }

    const where: any = {};
    if (email) where.email = email;
    if (phone) where.phone = phone;

    const user = await User.findOne({ where });

    // Si existe y está deshabilitado, bloqueamos el login
    const disabledValue = (user as any)?.disabled;
    const isDisabled =
      disabledValue === true ||
      disabledValue === 1 ||
      disabledValue === "1";
    const isDeleted = (user as any)?.is_deleted === true || (user as any)?.is_deleted === 1;

    if (user && (isDisabled || isDeleted)) {
      writeSecurityAuditFromRequest(req, {
        event: "auth.login.blocked_account",
        level: "warn",
        actorUserId: Number((user as any)?.id ?? 0) || null,
        targetUserId: Number((user as any)?.id ?? 0) || null,
        success: false,
        reason: isDeleted ? "deleted_account" : "disabled_account",
        meta: {
          email: String(email ?? "").trim().toLowerCase() || undefined,
          phone: String(phone ?? "").trim() || undefined,
        },
      });
      return res.status(401).json({
        header: { success: false },
        body: {
          // Evita enumeración de cuentas (mismo mensaje que credenciales inválidas)
          message: "User and/or Password not valid.",
        },
      });
    }

    // Si no está deshabilitado, seguimos al controlador de login
    return next();
  } catch (err) {
    console.error("checkDisabledBeforeLogin error:", err);
    return res.status(500).json({
      header: { success: false },
      body: { message: "Internal server error" },
    });
  }
};

router.post("/validate/email", validateEmailLimiter, validateEmail);
router.post("/verify/email", verifyEmailLimiter, verifyEmailCode);
router.post("/", signUpLimiter, signUp);
router.post("/image", signUpLimiter, signUp);

router.post("/login", loginLimiter, checkDisabledBeforeLogin, login);
router.post("/refresh", refreshLimiter, refreshToken);
router.patch("/refresh", refreshLimiter, refreshToken);
router.post("/refresh-token", refreshLimiter, refreshToken);
router.patch("/refresh-token", refreshLimiter, refreshToken);
router.post("/logout", TokenValidation(), logout);
router.post("/logout/device", TokenValidation(), logoutDevice);
router.post("/device-token", TokenValidation(), saveDeviceToken);
router.put("/device-token", TokenValidation(), saveDeviceToken);
router.patch("/device-token", TokenValidation(), saveDeviceToken);
router.post("/session/logout", TokenValidation(), logout);
router.post("/signout", TokenValidation(), logout);

router.post("/restore/request", restoreRequestLimiter, requestRestorePassword);
router.post("/restore/validate", restoreFlowLimiter, validateRestorePassword);
router.post("/restore", restoreFlowLimiter, restorePassword);
router.patch("/change_pass", TokenValidation(), changePass);
router.post("/phone/validate", buildAuthLimiter(
  "auth:phone_validate",
  process.env.AUTH_RATE_MAX_VALIDATE_EMAIL, // reuse same ceiling as email validate (25/min)
  25,
  "too many phone validation requests, try later",
  (req) => buildAuthIdentityKey(req, ["phone"])
), validatePhone);
router.get("/session/validate", TokenValidation(), validateSesion);

/**
 * Lightweight JWT-only ping — no DB queries, < 5ms.
 * Use this for the app startup check ("is user still logged in?").
 * Only verifies the cryptographic signature + grace period.
 * Does NOT check the session table or user status.
 *
 * Response codes the mobile client can act on:
 *   200 { valid: true }                    → token is good, proceed to home
 *   401 { code: "AUTH_TOKEN_EXPIRED",
 *          action: "refresh" }             → call /auth/refresh, do NOT logout
 *   401 { code: "AUTH_TOKEN_INVALID",
 *          action: "refresh" }             → try refresh before giving up
 *   401 { code: "AUTH_TOKEN_REQUIRED",
 *          action: "login" }               → no token present, show intro
 */
router.get("/session/ping", (req: any, res: any) => {
  try {
    const rawHeader = String(req.header("Authorization") ?? req.header("x-auth-token") ?? req.header("x-access-token") ?? "").trim();
    const token = rawHeader.toLowerCase().startsWith("bearer ")
      ? rawHeader.slice(7).trim()
      : rawHeader;

    if (!token || ["null", "undefined", "none", "nan"].includes(token.toLowerCase())) {
      return sendAuthError(res, 401, "AUTH_TOKEN_REQUIRED", "Token missing.");
    }

    const secrets = [
      String(process.env.SECRETORPRIVATEKEY ?? "").trim(),
      String(process.env.JWT_SECRET ?? "").trim(),
    ].filter(Boolean);

    const GRACE_MS = Math.max(0, Number(process.env.JWT_EXPIRATION_GRACE_DAYS ?? 1) || 1) * 24 * 60 * 60 * 1000;

    let payload: any = null;
    let sawExpired = false;
    for (const secret of secrets) {
      try {
        payload = jwt.verify(token, secret);
        break;
      } catch (err: any) {
        if (String(err?.name ?? "") === "TokenExpiredError") sawExpired = true;
      }
    }

    if (!payload) {
      // Try within grace period
      if (sawExpired) {
        for (const secret of secrets) {
          try {
            const p: any = jwt.verify(token, secret, { ignoreExpiration: true });
            if (p?.exp && Date.now() - Number(p.exp) * 1000 <= GRACE_MS) {
              payload = p;
            }
            break;
          } catch { /* next secret */ }
        }
      }
    }

    if (!payload) {
      return sawExpired
        ? sendAuthError(res, 401, "AUTH_TOKEN_EXPIRED", "Token expired.")
        : sendAuthError(res, 401, "AUTH_TOKEN_INVALID", "Token invalid.");
    }

    const tokenType = String(payload?.tokenType ?? payload?.token_type ?? "").trim().toLowerCase();
    if (tokenType && tokenType !== "access") {
      return sendAuthError(res, 401, "AUTH_TOKEN_EXPIRED", "Token expired.");
    }

    return res.status(200).json({ valid: true, user_id: payload?.userId ?? null });
  } catch (err) {
    return sendAuthError(res, 500, "AUTH_INTERNAL_ERROR", "Internal error.");
  }
});

export default router;
