import {
  Request,
  Response,
  formatResponse,
  repository,
  bcryptjs,
  generatePassword,
  uRepository,
  sendEmail,
} from "../_module/module";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { QueryTypes } from "sequelize";
import { getAccessJwtSecrets, getRefreshJwtSecrets } from "../../../libs/helper/generate_jwt";
import { getSocketInstance } from "../../../_sockets/socket_instance";
import User from "../../../_models/user/user";
import sequelize from "../../../_db/connection";
import * as followerRepo from "../../../repository/follower/follower_repository";
import { sendAuthError } from "../../../libs/middlewares/auth_error_response";
import {
  hasUserActivePersistentAuthSession,
  isUserAuthSessionActive,
  isUserAuthSessionExplicitlyRevoked,
  registerUserAuthSession,
  revokeAllUserAuthSessions,
  revokeAuthSessionsByDeviceUuid,
  revokeUserAuthSessionToken,
} from "../../../libs/auth/user_auth_session";
import { buildAuthSessionResponseBody } from "../../../libs/auth/auth_response_contract";
import logger from "../../../libs/logger/logger";

// Hash de costo 10 para dummy compare — evita timing oracle en "usuario no existe"
const DUMMY_HASH = bcryptjs.hashSync("__minhoo_dummy_timing_guard__", 10);

const normalizeDeviceToken = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase() === "null" || value.toLowerCase() === "undefined") return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const extractDeviceToken = (req: Request): string => {
  const body: any = req.body ?? {};
  const headers: any = req.headers ?? {};

  const candidates = [
    body?.uuid,
    body?.fcmToken,
    body?.fcm_token,
    body?.deviceToken,
    body?.device_token,
    body?.pushToken,
    body?.push_token,
    body?.firebaseToken,
    body?.firebase_token,
    body?.notificationToken,
    body?.notification_token,
    headers?.["x-device-token"],
    headers?.["x-fcm-token"],
    headers?.["x-push-token"],
    headers?.["x-notification-token"],
  ];

  for (const candidate of candidates) {
    const token = normalizeDeviceToken(candidate);
    if (token.length >= 20) return token;
  }

  return "";
};

const normalizePreferredLanguage = (raw: any): "es" | "en" | undefined => {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return undefined;

  if (
    normalized.startsWith("es") ||
    normalized.includes("spanish") ||
    normalized.includes("espanol") ||
    normalized.includes("español")
  ) {
    return "es";
  }

  if (
    normalized.startsWith("en") ||
    normalized.includes("english") ||
    normalized.includes("ingles") ||
    normalized.includes("inglés")
  ) {
    return "en";
  }

  return undefined;
};

const extractPreferredLanguage = (req: Request): "es" | "en" | undefined => {
  const body: any = req.body ?? {};
  const headers: any = req.headers ?? {};
  const candidates = [
    body?.language,
    body?.preferred_language,
    body?.preferredLanguage,
    body?.app_language,
    body?.appLanguage,
    body?.locale,
    body?.lang,
    headers?.["x-app-language"],
    headers?.["x-language"],
    headers?.["x-locale"],
  ];

  for (const candidate of candidates) {
    const normalized = normalizePreferredLanguage(candidate);
    if (normalized) return normalized;
  }

  return undefined;
};

const normalizeAuthToken = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const lowered = value.toLowerCase();
  if (lowered === "null" || lowered === "undefined" || lowered === "nan" || lowered === "none") {
    return "";
  }
  const token = lowered.startsWith("bearer ") ? value.slice(7).trim() : value;
  const tokenLowered = token.toLowerCase();
  if (
    tokenLowered === "null" ||
    tokenLowered === "undefined" ||
    tokenLowered === "nan" ||
    tokenLowered === "none"
  ) {
    return "";
  }
  return token;
};

const extractBearerToken = (req: Request): string => {
  const header = req.header("Authorization");
  if (!header) return "";
  return normalizeAuthToken(header);
};

const extractRefreshToken = (req: Request): string => {
  const body: any = req.body ?? {};
  const headers: any = req.headers ?? {};
  const candidates = [
    body?.refresh_token,
    body?.refreshToken,
    body?.token,
    body?.auth_token,
    headers?.["x-refresh-token"],
    headers?.["x-auth-refresh-token"],
    req.header("Authorization"),
  ];

  for (const candidate of candidates) {
    const token = normalizeAuthToken(candidate);
    if (token) return token;
  }
  return "";
};

const extractIssuedRefreshToken = (userLike: any): string => {
  const sources = [
    userLike,
    userLike?.dataValues,
    typeof userLike?.toJSON === "function" ? userLike.toJSON() : null,
  ];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const candidates = [
      source?.refresh_token,
      source?.refreshToken,
    ];
    for (const candidate of candidates) {
      const token = normalizeAuthToken(candidate);
      if (token) return token;
    }
  }

  return "";
};

const allowRefreshFromAccessToken = () =>
  !String(process.env.AUTH_ALLOW_ACCESS_TOKEN_REFRESH ?? "0")
    .trim()
    .match(/^(0|false|no|off)$/i);

const allowStaleRefreshTokenRecovery = () =>
  !String(process.env.AUTH_REFRESH_STALE_TOKEN_RECOVERY ?? "1")
    .trim()
    .match(/^(0|false|no|off)$/i);

const verifyJwtWithSecretsDetailed = (
  token: string,
  secrets: string[],
  ignoreExpiration = false
): { payload: any | null; expired: boolean } => {
  let sawExpired = false;
  for (const secret of secrets) {
    try {
      return { payload: jwt.verify(token, secret, { ignoreExpiration }) as any, expired: false };
    } catch (error: any) {
      if (String(error?.name ?? "").trim() === "TokenExpiredError") {
        sawExpired = true;
      }
    }
  }
  return { payload: null, expired: sawExpired };
};

/**
 * Grace period for EXPIRED refresh tokens.
 * Even after the JWT has cryptographically expired, we allow a configurable
 * window so users who haven't opened the app in a long time can still refresh
 * instead of being forced to re-login.
 * Default: 365 days. Set JWT_REFRESH_EXPIRATION_GRACE_DAYS=0 to disable.
 */
const REFRESH_TOKEN_GRACE_MS = (() => {
  const days = Math.max(
    0,
    Number(process.env.JWT_REFRESH_EXPIRATION_GRACE_DAYS ?? 365) || 365
  );
  return days * 24 * 60 * 60 * 1000;
})();

const resolveTokenType = (payload: any): string => {
  return String(payload?.tokenType ?? payload?.token_type ?? "")
    .trim()
    .toLowerCase();
};

const canRecoverRefreshWithActiveAccessToken = async ({
  req,
  userId,
  rawRefreshToken,
  storedAuthToken,
}: {
  req: Request;
  userId: number;
  rawRefreshToken: string;
  storedAuthToken: string;
}): Promise<boolean> => {
  const bearerAccessToken = extractBearerToken(req);
  if (!bearerAccessToken) return false;
  if (bearerAccessToken === rawRefreshToken) return false;

  const accessVerified = verifyJwtWithSecretsDetailed(
    bearerAccessToken,
    getAccessJwtSecrets()
  );
  const accessPayload = accessVerified.payload;
  if (!accessPayload) return false;

  const accessTokenType = resolveTokenType(accessPayload);
  if (accessTokenType && accessTokenType !== "access") return false;

  const accessUserId = Number(accessPayload?.userId ?? 0);
  if (!Number.isFinite(accessUserId) || accessUserId <= 0 || accessUserId !== userId) {
    return false;
  }

  const matchesLegacy = Boolean(storedAuthToken && storedAuthToken === bearerAccessToken);
  if (matchesLegacy) return true;

  return isUserAuthSessionActive(userId, bearerAccessToken).catch(() => false);
};

const AUTH_OP_SINGLE_FLIGHT_WINDOW_MS = Math.max(
  0,
  Math.min(
    30_000,
    Number(process.env.AUTH_OP_SINGLE_FLIGHT_WINDOW_MS ?? 10_000) || 10_000
  )
);
const AUTH_OP_DB_LOCK_TIMEOUT_SECONDS = Math.max(
  0,
  Math.min(15, Number(process.env.AUTH_OP_DB_LOCK_TIMEOUT_SECONDS ?? 6) || 6)
);
const AUTH_OP_SINGLE_FLIGHT_MAX_KEYS = Math.max(
  100,
  Number(process.env.AUTH_OP_SINGLE_FLIGHT_MAX_KEYS ?? 1000) || 1000
);

const authOpInFlight = new Map<string, Promise<any>>();
const authOpRecent = new Map<string, { atMs: number; value: any }>();

const cloneDeepSafe = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

const trimMap = <T>(map: Map<string, T>, maxKeys: number) => {
  if (map.size <= maxKeys) return;
  const overflow = map.size - maxKeys;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
};

const toShortHash = (raw: string): string =>
  crypto.createHash("sha1").update(String(raw ?? "")).digest("hex").slice(0, 16);

const withAuthIssueDbLock = async <T>(
  userId: number,
  deviceToken: string,
  producer: () => Promise<T>
): Promise<T> => {
  const isMysql = String(sequelize.getDialect() ?? "").toLowerCase() === "mysql";
  if (!isMysql || !Number.isFinite(userId) || userId <= 0) {
    return producer();
  }

  const lockName = `auth:issue:${Math.trunc(userId)}:${toShortHash(deviceToken || "no-device")}`;
  let lockAcquired = false;
  try {
    const rows = (await sequelize.query(
      `SELECT GET_LOCK(:lockName, :timeoutSeconds) AS acquired`,
      {
        replacements: {
          lockName,
          timeoutSeconds: AUTH_OP_DB_LOCK_TIMEOUT_SECONDS,
        },
        type: QueryTypes.SELECT,
      }
    )) as Array<{ acquired?: number | string | null }>;
    lockAcquired = Number(rows?.[0]?.acquired ?? 0) === 1;
  } catch (_error) {
    lockAcquired = false;
  }

  if (!lockAcquired) {
    return producer();
  }

  try {
    return await producer();
  } finally {
    try {
      await sequelize.query(`SELECT RELEASE_LOCK(:lockName) AS released`, {
        replacements: { lockName },
        type: QueryTypes.SELECT,
      });
    } catch (_error) {
      // ignore lock release failure
    }
  }
};

const runAuthSingleFlight = async <T>(
  key: string,
  producer: () => Promise<T>
): Promise<T> => {
  const safeKey = String(key ?? "").trim().slice(0, 220);
  if (!safeKey || AUTH_OP_SINGLE_FLIGHT_WINDOW_MS <= 0) {
    return producer();
  }

  const now = Date.now();
  const cached = authOpRecent.get(safeKey);
  if (cached && now - cached.atMs <= AUTH_OP_SINGLE_FLIGHT_WINDOW_MS) {
    return cloneDeepSafe(cached.value);
  }

  const inFlight = authOpInFlight.get(safeKey);
  if (inFlight) {
    const shared = await inFlight;
    return cloneDeepSafe(shared);
  }

  const promise = (async () => {
    const result = await producer();
    authOpRecent.set(safeKey, {
      atMs: Date.now(),
      value: cloneDeepSafe(result),
    });
    trimMap(authOpRecent, AUTH_OP_SINGLE_FLIGHT_MAX_KEYS);
    return result;
  })();

  authOpInFlight.set(safeKey, promise);
  trimMap(authOpInFlight, AUTH_OP_SINGLE_FLIGHT_MAX_KEYS);
  try {
    const result = await promise;
    return cloneDeepSafe(result);
  } finally {
    authOpInFlight.delete(safeKey);
  }
};

export const login = async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const roles: any = []; //
    const email = String(req.body?.email ?? "").trim();
    const inputPassword = String(
      req.body?.password ?? req.body?.clave ?? req.body?.pass ?? ""
    );
    const uuid = extractDeviceToken(req);
    const preferredLanguage = extractPreferredLanguage(req);

    if (!email || !inputPassword) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }

    // Lookup de login ligero (evita includes pesados en esta etapa).
    const userLookupStartedAt = Date.now();
    const userTemp = await repository.findByEmailForLogin(email);
    const userLookupMs = Date.now() - userLookupStartedAt;
    if (!userTemp) {
      // Dummy compare para igualar tiempo de respuesta y evitar timing oracle
      await bcryptjs.compare(inputPassword, DUMMY_HASH);
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }
    if ((userTemp as any).is_deleted === true || (userTemp as any).is_deleted === 1) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        code: 403,
        message:
          "Your account has been deleted. Please contact info@minhoo.app to reactivate your account.",
      });
    }
    if ((userTemp as any).disabled === true || (userTemp as any).disabled === 1) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        code: 403,
        message: "This account has been disabled by an administrator.",
      });
    }
    if ((userTemp as any).available === false || (userTemp as any).available === 0) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }
    const storedPassword = String(userTemp.password ?? "");
    if (!storedPassword) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    }

    let validatePass = false;
    let shouldUpgradeToHash = false;

    try {
      const looksLikeHash = /^\$2[aby]\$\d{2}\$/.test(storedPassword);
      if (looksLikeHash) {
        // Async compare avoids blocking the event loop under concurrent login load.
        validatePass = await bcryptjs.compare(inputPassword, storedPassword);
      } else {
        // Compatibilidad con cuentas antiguas que aún tienen clave en texto plano.
        validatePass = storedPassword === inputPassword;
        shouldUpgradeToHash = validatePass;
      }
    } catch (_error) {
      // Si el valor guardado no es un hash válido, probamos comparación directa.
      validatePass = storedPassword === inputPassword;
      shouldUpgradeToHash = validatePass;
    }

    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "User and/or Password not valid.",
      });
    } else {
      if (shouldUpgradeToHash) {
        await uRepository.update(userTemp.id, {
          password: generatePassword(inputPassword),
        });
      }

      const loginUserId = Number((userTemp as any)?.id ?? userTemp?.get?.("id"));
      const loginClaims = Number.isFinite(loginUserId) && loginUserId > 0
        ? await repository.findLoginClaimsById(loginUserId)
        : null;

      (loginClaims as any)?.roles?.forEach((u: any) => {
        roles.push(u.id);
      });

      const totalMs = Date.now() - startedAt;
      console.log(
        `[perf][login] email=${email} totalMs=${totalMs} lookupMs=${userLookupMs}`
      );
      const workerId =
        (loginClaims as any)?.get?.("worker") != null
          ? (loginClaims as any).get("worker")["id"]
          : null;
      const singleFlightKey = `login:${loginUserId}:${toShortHash(uuid || "no-device")}`;
      const authSessionBody = await runAuthSingleFlight(singleFlightKey, async () =>
        withAuthIssueDbLock(loginUserId, uuid, async () => {
          const countsPromise =
            Number.isFinite(loginUserId) && loginUserId > 0
              ? followerRepo.getCounts(loginUserId).catch((_error) => null)
              : Promise.resolve(null as any);

          const user = await repository.saveToken({
            userId: loginUserId,
            uuid,
            roles: roles,
            workerId,
          });

          if (preferredLanguage && preferredLanguage !== String((user as any)?.language ?? "")) {
            try {
              await uRepository.update(userTemp.id, { language: preferredLanguage });
              if (typeof (user as any)?.setDataValue === "function") {
                (user as any).setDataValue("language", preferredLanguage);
              } else if (user) {
                (user as any).language = preferredLanguage;
              }
            } catch (languageError) {
              console.log("[login] preferred language update skipped", languageError);
            }
          }

          let counts: { followersCount: number; followingCount: number } | null = null;
          if (Number.isFinite(loginUserId) && loginUserId > 0) {
            counts = await countsPromise;
            if (counts) {
              const fields = {
                followers_count: counts.followersCount,
                followings_count: counts.followingCount,
                following_count: counts.followingCount,
                followersCount: counts.followersCount,
                followingsCount: counts.followingCount,
                followingCount: counts.followingCount,
              };

              if (typeof (user as any)?.setDataValue === "function") {
                Object.entries(fields).forEach(([key, value]) => {
                  (user as any).setDataValue(key, value);
                });
              } else if (user) {
                Object.assign(user as any, fields);
              }
            }
          }

          return buildAuthSessionResponseBody(user, {
            counts: counts
              ? {
                  followersCount: counts.followersCount,
                  followingCount: counts.followingCount,
                  followers_count: counts.followersCount,
                  followings_count: counts.followingCount,
                  following_count: counts.followingCount,
                }
              : null,
          });
        })
      );
      return formatResponse({
        res: res,
        success: true,
        body: authSessionBody,
      });
    }
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  try {
    const rawRefreshToken = extractRefreshToken(req);
    if (!rawRefreshToken) {
      return sendAuthError(res, 401, "AUTH_TOKEN_REQUIRED", "Refresh token missing.");
    }

    const refreshSecrets = getRefreshJwtSecrets();
    const verified = verifyJwtWithSecretsDetailed(rawRefreshToken, refreshSecrets);
    let payload = verified.payload;

    // If the refresh token has cryptographically expired, apply the grace window.
    // This lets users who haven't opened the app in a long time still refresh
    // instead of being forced to re-login from scratch.
    if (!payload && verified.expired && REFRESH_TOKEN_GRACE_MS > 0) {
      const verifiedIgnoringExp = verifyJwtWithSecretsDetailed(rawRefreshToken, refreshSecrets, true);
      if (verifiedIgnoringExp.payload?.exp) {
        const expMs = Number(verifiedIgnoringExp.payload.exp) * 1000;
        if (Date.now() - expMs <= REFRESH_TOKEN_GRACE_MS) {
          payload = verifiedIgnoringExp.payload;
        }
      }
    }

    if (!payload) {
      if (verified.expired) {
        return sendAuthError(
          res,
          401,
          "AUTH_TOKEN_EXPIRED",
          "Refresh token expired."
        );
      }
      return sendAuthError(res, 401, "AUTH_TOKEN_INVALID", "Invalid refresh token.");
    }

    const tokenType = resolveTokenType(payload);
    if (tokenType && tokenType !== "refresh") {
      if (!(allowRefreshFromAccessToken() && tokenType === "access")) {
        return sendAuthError(
          res,
          401,
          "AUTH_TOKEN_INVALID",
          "Invalid refresh token type."
        );
      }
    }

    const userId = Number(payload?.userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return sendAuthError(
        res,
        401,
        "AUTH_TOKEN_INVALID",
        "Invalid refresh token payload."
      );
    }

    const userStatus = await User.findOne({
      where: { id: userId },
      attributes: ["id", "available", "disabled", "auth_token", "uuid"],
    });
    if (!userStatus || !(userStatus as any).available) {
      return sendAuthError(
        res,
        401,
        "AUTH_SESSION_REVOKED",
        "Access denied, user not found."
      );
    }
    if (Boolean((userStatus as any).disabled)) {
      return sendAuthError(
        res,
        401,
        "AUTH_SESSION_REVOKED",
        "This account has been disabled by an administrator."
      );
    }

    const storedAuthToken = normalizeAuthToken((userStatus as any)?.auth_token);
    const tokenMatchesLegacy = Boolean(storedAuthToken && storedAuthToken === rawRefreshToken);
    let tokenMatchesSession = tokenMatchesLegacy
      ? true
      : await isUserAuthSessionActive(userId, rawRefreshToken, {
          allowRefreshGrace: true,
        });

    if (!tokenMatchesSession) {
      // Only hard-block if the refresh token was explicitly revoked.
      // If it simply has no session record (app reinstall, DB gap), allow the
      // refresh so the user gets new tokens without being forced to re-login.
      const isExplicitlyRevoked = await isUserAuthSessionExplicitlyRevoked(userId, rawRefreshToken).catch(() => false);
      if (isExplicitlyRevoked) {
        const requestUuid = extractDeviceToken(req);
        const storedUuid = normalizeDeviceToken((userStatus as any)?.uuid ?? "");
        const uuidHint = requestUuid || storedUuid;

        let hasRecoverableSessionForDevice = false;
        if (uuidHint) {
          hasRecoverableSessionForDevice = await hasUserActivePersistentAuthSession(userId, {
            deviceUuid: uuidHint,
          }).catch(() => false);
        }
        let hasRecoverableSession = hasRecoverableSessionForDevice;
        if (!hasRecoverableSession) {
          hasRecoverableSession = await hasUserActivePersistentAuthSession(userId).catch(
            () => false
          );
        }

        const recoveredWithActiveAccess = await canRecoverRefreshWithActiveAccessToken({
          req,
          userId,
          rawRefreshToken,
          storedAuthToken,
        });
        if (recoveredWithActiveAccess) {
          // Client may be presenting a stale rotated refresh token while still
          // holding a valid access token for the same user/device.
          // Allow this request to re-issue tokens and heal local storage.
          tokenMatchesSession = true;
        } else if (
          allowStaleRefreshTokenRecovery() &&
          hasRecoverableSessionForDevice &&
          Boolean(uuidHint)
        ) {
          console.warn(
            `[auth][refresh] recover stale refresh token with active device session userId=${userId}`
          );
          tokenMatchesSession = true;
        } else if (hasRecoverableSession) {
          return sendAuthError(
            res,
            401,
            "AUTH_TOKEN_EXPIRED",
            "Refresh token rotated. Retry with latest session token.",
            false,
            "stale_refresh_token"
          );
        } else {
          return sendAuthError(
            res,
            401,
            "AUTH_SESSION_REVOKED",
            "Refresh token revoked.",
            false,
            "refresh_token_revoked"
          );
        }
      }
      // Refresh token is cryptographically valid but has no session record — allow it.
    }

    const userTemp = await repository.findByIdForRefresh(userId);
    if (!userTemp) {
      return sendAuthError(
        res,
        401,
        "AUTH_SESSION_REVOKED",
        "Access denied, user not found."
      );
    }

    const roles: number[] = [];
    const userRoles = (userTemp as any)?.roles;
    if (Array.isArray(userRoles)) {
      userRoles.forEach((role: any) => {
        const roleId = Number(role?.id);
        if (Number.isFinite(roleId) && roleId > 0) {
          roles.push(roleId);
        }
      });
    }

    const uuid = extractDeviceToken(req);
    const workerId =
      (userTemp as any)?.worker != null
        ? Number((userTemp as any)?.worker?.id ?? 0) || null
        : null;
    const refreshKeyBase = `${userId}:${toShortHash(uuid || normalizeDeviceToken((userStatus as any)?.uuid ?? "") || "no-device")}`;
    const refreshTokenHash = toShortHash(rawRefreshToken);
    const singleFlightKey = `refresh:${refreshKeyBase}:${refreshTokenHash}`;
    const body = await runAuthSingleFlight(singleFlightKey, async () =>
      withAuthIssueDbLock(userId, uuid || normalizeDeviceToken((userStatus as any)?.uuid ?? ""), async () => {
        const user = await repository.saveToken({
          userId,
          uuid,
          roles,
          workerId,
        });

        const issuedRefreshToken = extractIssuedRefreshToken(user);
        if (!issuedRefreshToken || issuedRefreshToken !== rawRefreshToken) {
          await revokeUserAuthSessionToken(userId, rawRefreshToken, "refresh_rotation");
        } else {
          console.warn(
            `[auth][refresh] skip revoke due same refresh token collision userId=${userId}`
          );
        }

        return buildAuthSessionResponseBody(user, { refreshed: true });
      })
    );
    return formatResponse({
      res,
      success: true,
      body,
    });
  } catch (error) {
    console.log("[auth][refresh] unexpected error", error);
    return sendAuthError(
      res,
      500,
      "AUTH_INTERNAL_ERROR",
      "Internal auth error"
    );
  }
};

export const changePass = async (req: Request, res: Response) => {
  try {
    const { current_password, password, confirm_password } = req.body;
    //Validar Existencia de Usuario
    const userTemp = await repository.findById(req.userId);

    const validatePass = bcryptjs.compareSync(
      String(current_password),
      userTemp?.password
    );
    if (!validatePass) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Current password not valid.",
      });
    }
    if (password !== confirm_password) {
      return formatResponse({
        islogin: true,
        res: res,
        success: false,
        message: "Password and password confirmation do not match",
      });
    }
    const hashPassword = generatePassword(password as string);
    req.body.password = hashPassword;
    const body = {
      password: hashPassword,
      temp_code: null,
      created_temp_code: null,
    };
    await uRepository.update(userTemp?.id, body);
    const emailParams = {
      subject: "reset password",
      email: userTemp!.email,
      htmlPath: "./src/public/html/email/successful_password_change_email.html",
      replacements: [{ name: userTemp!.name }],
      from: "Minhoo App",
    };

    sendEmail(emailParams);
    return formatResponse({ res: res, success: true });
  } catch (error) {
    return formatResponse({ res: res, success: false, message: error });
  }
};
export const validateSesion = async (_req: Request, res: Response) => {
  try {
    return formatResponse({ res: res, success: true });
  } catch (error) {}
};

const disconnectUserSockets = async (userId: number, onlyAuthToken?: string) => {
  try {
    const io = getSocketInstance();
    if (!io || !userId) return;

    const userRoom = `user_${userId}`;
    const namespaces = ["/", "/api", "/api/v1"];
    for (const namespace of namespaces) {
      const sockets = await io.of(namespace).in(userRoom).fetchSockets();
      for (const s of sockets) {
        if (onlyAuthToken) {
          const socketToken = normalizeAuthToken((s.data as any)?.authToken);
          if (!socketToken || socketToken !== onlyAuthToken) continue;
        }
        s.disconnect(true);
      }
    }
  } catch (error) {
    console.log("⚠️ logout socket disconnect error", error);
  }
};

export const logout = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid session user.",
      });
    }

    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      await revokeUserAuthSessionToken(userId, bearerToken, "manual_logout");
      await User.update(
        { auth_token: null },
        {
          where: {
            id: userId,
            auth_token: bearerToken,
          },
        }
      );
      await disconnectUserSockets(userId, bearerToken);
    } else {
      await revokeAllUserAuthSessions(userId, "manual_logout_all");
      await uRepository.update(userId, {
        auth_token: null,
        uuid: null,
      });
      await disconnectUserSockets(userId);
    }

    return formatResponse({ res, success: true });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};

export const logoutDevice = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid session user.",
      });
    }

    const rawUuid = extractDeviceToken(req);
    if (!rawUuid || rawUuid.length < 20) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid device token.",
      });
    }

    await revokeAuthSessionsByDeviceUuid(rawUuid, {
      userId,
      reason: "manual_logout_device",
    });

    await User.update(
      { uuid: null },
      { where: { id: userId, uuid: rawUuid } }
    );

    return formatResponse({ res, success: true });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};

export const saveDeviceToken = async (req: Request, res: Response) => {
  try {
    const userId = Number((req as any).userId ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return formatResponse({
        res,
        success: false,
        message: "Invalid session user.",
      });
    }

    const token = extractDeviceToken(req);
    if (!token || token.length < 20) {
      return formatResponse({
        res,
        success: false,
        code: 400,
        message: "Invalid device token.",
      });
    }

    await uRepository.assignUuid(userId, token);
    // Keep multi-device auth session table aligned with the latest push token.
    // This helps when push targeting falls back to active session tokens.
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      await registerUserAuthSession(userId, bearerToken, {
        deviceUuid: token,
      });
    }

    return formatResponse({
      res,
      success: true,
      body: { saved: true },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};
//
