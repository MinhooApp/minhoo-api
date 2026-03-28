// middlewares/token-optional.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";
import { IPayload } from "./verify_jwt";
import { isUserAuthSessionActive } from "../auth/user_auth_session";

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
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
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

const verifyTokenWithKnownSecrets = (token: string): IPayload | null => {
  for (const secret of getJwtSecrets()) {
    try {
      return jwt.verify(token, secret) as IPayload;
    } catch (_err) {
      // try next configured secret
    }
  }
  return null;
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
    req.authenticated = false; // por defecto anónimo

    // 1) Obtener token (headers por defecto; query/body solo si está habilitado)
    const token = extractOptionalAuthToken(req);

    // 2) Si no hay token -> anónimo (salvo que allowedRoles obligue auth)
    if (!token) {
      if (allowedRoles && allowedRoles.length > 0) {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, authentication required"],
        });
      }
      return next();
    }

    // 3) Intentar verificar token; si falla, seguimos anónimos salvo allowedRoles
    try {
      const verified = verifyTokenWithKnownSecrets(token);
      if (!verified) {
        throw new Error("invalid token signature");
      }
      const tokenType = String(
        (verified as any)?.tokenType ?? (verified as any)?.token_type ?? ""
      )
        .trim()
        .toLowerCase();
      if (tokenType && tokenType !== "access") {
        throw new Error("invalid token type");
      }
      const { userId, roles, workerId } = verified;
      const normalizedRoles = Array.isArray(roles) ? roles : [];

      // 4) Verificaciones de usuario en BD (opcional pero recomendable)
      const user = await User.findOne({
        where: { id: userId },
        attributes: ["id", "available", "disabled", "auth_token"],
      });
      if (!user || !(user as any).available || Boolean((user as any).disabled)) {
        // Token válido pero usuario no existe / no disponible -> tratar como no autenticado
        if (allowedRoles && allowedRoles.length > 0) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, user not available"],
          });
        }
        return next();
      }

      const storedAuthToken = String((user as any).auth_token ?? "").trim();
      const tokenMatchesLegacy = Boolean(storedAuthToken && storedAuthToken === token);
      const tokenMatchesSession = tokenMatchesLegacy
        ? true
        : await isUserAuthSessionActive(userId, token);
      if (!tokenMatchesSession) {
        // Token válido pero usuario no existe / no disponible -> tratar como no autenticado
        if (allowedRoles && allowedRoles.length > 0) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, invalid session"],
          });
        }
        return next();
      }

      // 5) Adjuntar datos al request
      req.userId = userId;
      req.workerId = workerId;
      req.roles = normalizedRoles;
      req.authenticated = true;

      // 6) Si hay allowedRoles, validar
      if (allowedRoles && !normalizedRoles.some((r) => allowedRoles.includes(r))) {
        return res.status(403).json({
          header: { success: false, authenticated: true },
          messages: ["Access denied, role not allowed"],
        });
      }

      return next();
    } catch {
      // Token inválido -> anónimo salvo que allowedRoles obligue auth
      if (allowedRoles && allowedRoles.length > 0) {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, invalid token"],
        });
      }
      return next();
    }
  };
};

export default TokenOptional;
