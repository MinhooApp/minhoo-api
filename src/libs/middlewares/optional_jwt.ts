// middlewares/token-optional.ts
import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";
import { IPayload } from "./verify_jwt";

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

    // 1) Obtener token desde Authorization o ?urlToken=
    let token: string | undefined = req.header("Authorization");
    const urlToken = req.query.urlToken
      ? String(req.query.urlToken)
      : undefined;

    if (!token || !token.startsWith("Bearer ")) {
      token = urlToken; // si viene por query
    } else {
      token = token.split(" ")[1];
    }

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
      const { userId, roles, workerId } = jwt.verify(
        token,
        process.env.SECRETORPRIVATEKEY || "tokenTest"
      ) as IPayload;

      // 4) Verificaciones de usuario en BD (opcional pero recomendable)
      const user = await User.findOne({ where: { id: userId } });
      if (!user || !user.available) {
        // Token válido pero usuario no existe / no disponible -> tratar como no autenticado
        if (allowedRoles && allowedRoles.length > 0) {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, user not available"],
          });
        }
        return next();
      }

      // 5) Adjuntar datos al request
      req.userId = userId;
      req.workerId = workerId;
      req.roles = roles;
      req.authenticated = true;

      // 6) Si hay allowedRoles, validar
      if (allowedRoles && !roles.some((r) => allowedRoles.includes(r))) {
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
