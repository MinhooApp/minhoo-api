// C:\api\minhoo_api\src\libs\middlewares\verify_jwt.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";
import { isUserAuthSessionActive } from "../auth/user_auth_session";

export interface IPayload {
  userId: number;
  workerId: number;
  uid: string;
  name: string;
  username: string;
  roles: number[];     // array de roles
  token: string;
  tokenType?: string;
  token_type?: string;
  exp?: number;
  iat?: number;
}

const getJwtSecrets = (): string[] => {
  const secrets = [
    (process.env.SECRETORPRIVATEKEY ?? "").trim(),
    (process.env.JWT_SECRET ?? "").trim(),
  ].filter(Boolean);

  return Array.from(new Set(secrets));
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

const normalizeTokenCandidate = (raw: any): string => {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim();
  }
  return value;
};

const extractAuthToken = (req: Request): string => {
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

  const bodyAny = (req as any)?.body ?? {};
  const bodyCandidates = [
    bodyAny?.auth_token,
    bodyAny?.authToken,
    bodyAny?.token,
    bodyAny?.access_token,
    bodyAny?.accessToken,
  ];
  for (const candidate of bodyCandidates) {
    const token = normalizeTokenCandidate(candidate);
    if (token) return token;
  }

  return "";
};

/**
 * Validación “tolerante” + bloqueo por cuenta deshabilitada:
 * - 401 solo si la firma del token es inválida, no existe, o está revocado.
 * - Gracia de expiración (0 por defecto; solo aplica si se configura por env).
 * - Si la DB falla, no forzamos logout (modo degradado).
 * - Si el usuario está deshabilitado -> 403 siempre.
 */
export const TokenValidation = (
  allowedRoles?: number[],
  graceDays = Math.max(
    0,
    Number(process.env.JWT_EXPIRATION_GRACE_DAYS ?? 0) || 0
  )
): RequestHandler => {
  const GRACE_MS = graceDays * 24 * 60 * 60 * 1000;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 0) Obtener token (Authorization Bearer + compatibilidad legacy)
      const token = extractAuthToken(req);
      if (!token) {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, token missing"],
        });
      }

      // 1) Verificar firma real; si expiró, aplicar gracia SOLO con firma válida
      let payload: IPayload | null = null;
      const verified = verifyTokenWithKnownSecrets(token, false);
      if (verified) {
        payload = verified;
      } else {
        const verifiedIgnoringExp = verifyTokenWithKnownSecrets(token, true);
        if (!verifiedIgnoringExp || !verifiedIgnoringExp.exp) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, invalid token"],
          });
        }
        const expMs = Number(verifiedIgnoringExp.exp) * 1000;
        const now = Date.now();
        if (now - expMs <= GRACE_MS) {
          payload = verifiedIgnoringExp;
        } else {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, token expired"],
          });
        }
      }

      const tokenType = String(
        (payload as any)?.tokenType ?? (payload as any)?.token_type ?? ""
      )
        .trim()
        .toLowerCase();
      if (tokenType && tokenType !== "access") {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, invalid token type"],
        });
      }

      const { userId, roles, workerId } = payload!;

      // 2) Cargar usuario y aplicar reglas de seguridad
      try {
        const user = await User.findOne({
          where: { id: userId, available: true },
          attributes: ["id", "disabled", "available", "auth_token"],
        });

        if (!user) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, user not found"],
          });
        }

        const storedAuthToken = String((user as any).auth_token ?? "").trim();
        const tokenMatchesLegacy = Boolean(storedAuthToken && storedAuthToken === token);
        const tokenMatchesSession = tokenMatchesLegacy
          ? true
          : await isUserAuthSessionActive(userId, token);
        if (!tokenMatchesSession) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, token revoked"],
          });
        }

        // Cuenta deshabilitada por admin
        if ((user as any).disabled === true || (user as any).available === false) {
          return res.status(403).json({
            header: { success: false, authenticated: true },
            messages: ["This account has been disabled by an administrator"],
          });
        }

        // Campo legacy opcional; el control principal usa req.roles desde JWT verificado.
        (req as any).userRole = undefined;
      } catch (_dbErr) {
        // DB caída / intermitente → no romper sesión
        (req as any).authDegraded = true;
      }

      // 3) Filtro de roles si la ruta lo pidió
      if (allowedRoles && !roles?.some((r) => allowedRoles.includes(r))) {
        return res.status(403).json({
          header: { success: false, authenticated: true },
          messages: ["Access denied, role not allowed"],
        });
      }

      // 4) Contexto para el resto de middlewares/controladores
      (req as any).roles = roles;
      (req as any).userId = userId;
      (req as any).workerId = workerId;

      return next();
    } catch (error) {
      console.error("Auth middleware error:", error);
      return res.status(500).json({
        header: { success: false, authenticated: false },
        messages: ["Internal server error"],
      });
    }
  };
};

export default TokenValidation;
