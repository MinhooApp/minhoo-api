import Router from "express";
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
import { createRequestRateLimiter } from "../../../libs/middlewares/request_rate_limiter";
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
  createRequestRateLimiter({
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
router.post("/logout", TokenValidation(), logout);
router.post("/logout/device", TokenValidation(), logoutDevice);
router.post("/device-token", TokenValidation(), saveDeviceToken);
router.post("/session/logout", TokenValidation(), logout);
router.post("/signout", TokenValidation(), logout);

router.post("/restore/request", restoreRequestLimiter, requestRestorePassword);
router.post("/restore/validate", restoreFlowLimiter, validateRestorePassword);
router.post("/restore", restoreFlowLimiter, restorePassword);
router.patch("/change_pass", TokenValidation(), changePass);
router.post("/phone/validate", validatePhone);
router.get("/session/validate", TokenValidation(), validateSesion);

export default router;
