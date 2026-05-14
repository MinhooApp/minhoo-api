// middlewares/token-optional.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";
import { IPayload } from "./verify_jwt";
import {
  hasUserActivePersistentAuthSession,
  isUserAuthSessionActive,
} from "../auth/user_auth_session";
import { sendAuthError } from "./auth_error_response";

// Extiende el tipo Request para tus campos
declare global {
  namespace Express {
    interface Request {
      userId: number;
      workerId: number;
      roles?: number[];
      authenticated?: boolean; // true si el token fue válido
    }
  }
}

const getJwtSecrets = (): string[] => {
  const secrets = [
    (process.env.SECRETORPRIVATEKEY ?? "").trim(),
    (process.env.JWT_SECRET ?? "").trim(),
  ].filter(Boolean);
  return Array.from(new Set(secrets));
};

const IS_PRODUCTION =
  String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
const OPTIONAL_JWT_GRACE_DAYS = Math.max(
  0,
  Number(
    process.env.OPTIONAL_JWT_EXPIRATION_GRACE_DAYS ??
      process.env.JWT_EXPIRATION_GRACE_DAYS ??
      0
  ) || 0
);
const OPTIONAL_JWT_GRACE_MS = OPTIONAL_JWT_GRACE_DAYS * 24 * 60 * 60 * 1000;

const isTruthy = (value: any): boolean => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

const ALLOW_LEGACY_TOKEN_TRANSPORT = (() => {
  const configured = process.env.AUTH_ALLOW_TOKEN_IN_QUERY_BODY;
  if (configured === undefined) return !IS_PRODUCTION;
  return isTruthy(configured);
})();

const normalizeTokenCandidate = (raw: any): string => {
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

const extractOptionalAuthToken = (req: Request): string => {
  const headerCandidates = [
    req.header("Authorization"),
    req.header("x-auth-token"),
    req.header("x-access-token"),
    req.header("auth_token"),
  ];
  for (const candidate of headerCandidates) {
    const token = normalizeTokenCandidate(candidate);
    if (token) return token;
  }

  if (!ALLOW_LEGACY_TOKEN_TRANSPORT) return "";

  const queryCandidates = [
    (req.query as any)?.urlToken,
    (req.query as any)?.auth_token,
    (req.query as any)?.authToken,
    (req.query as any)?.token,
  ];
  for (const candidate of queryCandidates) {
    const token = normalizeTokenCandidate(candidate);
    if (token) return token;
  }

  const body: any = (req as any)?.body ?? {};
  const bodyCandidates = [
    body?.auth_token,
    body?.authToken,
    body?.token,
    body?.access_token,
    body?.accessToken,
  ];
  for (const candidate of bodyCandidates) {
    const token = normalizeTokenCandidate(candidate);
    if (token) return token;
  }

  return "";
};

const verifyTokenWithKnownSecrets = (
  token: string,
  ignoreExpiration = false
): IPayload | null => {
  for (const secret of getJwtSecrets()) {
    try {
      return jwt.verify(token, secret, { ignoreExpiration }) as IPayload;
    } catch (_err) {
      // try next configured secret
    }
  }
  return null;
};

const verifyOptionalTokenWithGrace = (token: string): IPayload | null => {
  const strict = verifyTokenWithKnownSecrets(token, false);
  if (strict) return strict;
  if (OPTIONAL_JWT_GRACE_MS <= 0) return null;

  const relaxed = verifyTokenWithKnownSecrets(token, true);
  if (!relaxed) return null;

  const expMs = Number((relaxed as any)?.exp ?? 0) * 1000;
  if (!Number.isFinite(expMs) || expMs <= 0) return null;
  if (Date.now() - expMs > OPTIONAL_JWT_GRACE_MS) return null;
  return relaxed;
};

/**
 * TokenOptional:
 * - No exige token.
 * - Si hay token válido: setea req.userId, req.workerId, req.roles y req.authenticated=true.
 * - Si no hay token o es inválido: sigue como anónimo (req.authenticated=false).
 * - Si se indican allowedRoles:
 *    - Si no está autenticado => 401
 *    - Si está autenticado pero sin rol permitido => 403
 */
export const TokenOptional = (allowedRoles?: number[]): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const reqAny = req as any;
    const setOptionalState = (
      state: string,
      tokenPresent: boolean,
      code?: string,
      action?: string
    ) => {
      reqAny.authOptionalState = state;
      reqAny.authOptionalTokenPresent = tokenPresent ? 1 : 0;
      reqAny.authOptionalCode = code ?? "";
      reqAny.authOptionalAction = action ?? "";
    };

    req.authenticated = false; // por defecto anónimo

    // 1) Obtener token (headers por defecto; query/body solo si está habilitado)
    const token = extractOptionalAuthToken(req);

    // 2) Si no hay token -> anónimo (salvo que allowedRoles obligue auth)
    if (!token) {
      setOptionalState("missing", false);
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(
          res,
          401,
          "AUTH_TOKEN_REQUIRED",
          "Access denied, authentication required"
        );
      }
      return next();
    }

    // 3) Verificar token (si falla, seguimos anónimos salvo allowedRoles)
    const verified = verifyOptionalTokenWithGrace(token);
    if (!verified) {
      setOptionalState("invalid_token", true, "AUTH_TOKEN_INVALID", "refresh");
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(res, 401, "AUTH_TOKEN_INVALID", "Access denied, invalid token");
      }
      return next();
    }

    const tokenType = String(
      (verified as any)?.tokenType ?? (verified as any)?.token_type ?? ""
    )
      .trim()
      .toLowerCase();
    if (tokenType && tokenType !== "access") {
      setOptionalState("expired_token", true, "AUTH_TOKEN_EXPIRED", "refresh");
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(res, 401, "AUTH_TOKEN_EXPIRED", "Access denied, token expired");
      }
      return next();
    }

    const { userId, roles, workerId } = verified;
    const normalizedRoles = Array.isArray(roles) ? roles : [];

    // 4) Verificaciones de usuario en BD (si la DB falla: no devolver 401 por error temporal)
    let user: any = null;
    try {
      user = await User.findOne({
        where: { id: userId },
        attributes: ["id", "available", "disabled", "auth_token", "uuid"],
      });
    } catch (_dbErr) {
      setOptionalState(
        "backend_unavailable",
        true,
        "AUTH_BACKEND_UNAVAILABLE",
        "retry"
      );
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(
          res,
          503,
          "AUTH_BACKEND_UNAVAILABLE",
          "Authentication backend unavailable"
        );
      }
      (req as any).authDegraded = true;
      return next();
    }

    if (!user || !(user as any).available || Boolean((user as any).disabled)) {
      setOptionalState(
        "user_unavailable",
        true,
        "AUTH_SESSION_REVOKED",
        "logout"
      );
      // Token válido pero usuario no disponible/revocado -> anónimo salvo ruta protegida
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(
          res,
          401,
          "AUTH_SESSION_REVOKED",
          "Access denied, user not available"
        );
      }
      return next();
    }

    let tokenMatchesSession = false;
    try {
      const storedAuthToken = String((user as any).auth_token ?? "").trim();
      const tokenMatchesLegacy = Boolean(storedAuthToken && storedAuthToken === token);
      tokenMatchesSession = tokenMatchesLegacy
        ? true
        : await isUserAuthSessionActive(userId, token);
    } catch (_dbErr) {
      setOptionalState(
        "backend_unavailable",
        true,
        "AUTH_BACKEND_UNAVAILABLE",
        "retry"
      );
      if (allowedRoles && allowedRoles.length > 0) {
        return sendAuthError(
          res,
          503,
          "AUTH_BACKEND_UNAVAILABLE",
          "Authentication backend unavailable"
        );
      }
      (req as any).authDegraded = true;
      return next();
    }

    if (!tokenMatchesSession) {
      setOptionalState("session_miss", true, "AUTH_TOKEN_EXPIRED", "refresh");
      if (allowedRoles && allowedRoles.length > 0) {
        const userDeviceUuid = String((user as any)?.uuid ?? "").trim();
        let hasRecoverableSession = false;
        if (userDeviceUuid) {
          hasRecoverableSession = await hasUserActivePersistentAuthSession(userId, {
            deviceUuid: userDeviceUuid,
          }).catch(() => false);
        }
        if (!hasRecoverableSession) {
          hasRecoverableSession = await hasUserActivePersistentAuthSession(userId).catch(
            () => false
          );
        }
        if (hasRecoverableSession) {
          return sendAuthError(
            res,
            401,
            "AUTH_TOKEN_EXPIRED",
            "Access denied, token expired"
          );
        }
        return sendAuthError(
          res,
          401,
          "AUTH_SESSION_REVOKED",
          "Access denied, invalid session"
        );
      }
      return next();
    }

    // 5) Adjuntar datos al request
    req.userId = userId;
    req.workerId = workerId;
    req.roles = normalizedRoles;
    req.authenticated = true;
    setOptionalState("verified", true);

    // 6) Si hay allowedRoles, validar
    if (allowedRoles && !normalizedRoles.some((r) => allowedRoles.includes(r))) {
      return sendAuthError(
        res,
        403,
        "AUTH_FORBIDDEN",
        "Access denied, role not allowed",
        true
      );
    }

    return next();
  };
};

export default TokenOptional;
