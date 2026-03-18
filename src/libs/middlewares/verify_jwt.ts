// C:\api\minhoo_api\src\libs\middlewares\verify_jwt.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";

export interface IPayload {
  userId: number;
  workerId: number;
  uid: string;
  name: string;
  username: string;
  roles: number[];     // array de roles
  token: string;
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

/**
 * Validación “tolerante” + bloqueo por cuenta deshabilitada:
 * - 401 solo si la firma del token es inválida, no existe, o está revocado.
 * - Gracia de expiración (7 días por defecto).
 * - Si la DB falla, no forzamos logout (modo degradado).
 * - Si el usuario está deshabilitado -> 403 siempre.
 */
export const TokenValidation = (
  allowedRoles?: number[],
  graceDays = 7
): RequestHandler => {
  const GRACE_MS = graceDays * 24 * 60 * 60 * 1000;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 0) Obtener token (header o ?urlToken=...)
      let header = req.header("Authorization");
      const urlToken = req.query.urlToken ? String(req.query.urlToken) : undefined;
      if (!header && urlToken) header = `Bearer ${urlToken}`;

      if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, token missing"],
        });
      }

      const token = header.split(" ")[1];

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

      const { userId, roles, workerId } = payload!;

      // 2) Cargar usuario y aplicar reglas de seguridad
      try {
        const user = await User.findOne({
          where: { id: userId, available: true },
          attributes: ["id", "disabled", "available", "auth_token", "role"],
        });

        if (!user) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, user not found"],
          });
        }

        // Token revocado o sesión cerrada:
        // - si auth_token está vacío => sesión inválida
        // - si auth_token no coincide => token revocado
        const storedAuthToken = String((user as any).auth_token ?? "").trim();
        if (!storedAuthToken || storedAuthToken !== token) {
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

        // Exponer rol “legacy” si otros middlewares lo usan
        (req as any).userRole = (user as any).role ?? undefined;
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
