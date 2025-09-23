import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";

export interface IPayload {
  userId: number;
  workerId: number;
  uid: string;
  name: string;
  username: string;
  roles: number[];
  token: string;
}

export const TokenValidation = (allowedRoles?: number[]): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let token: string | undefined = req.header("Authorization");
      const urlToken = req.query.urlToken
        ? String(req.query.urlToken)
        : undefined;

      // I normalize token reading (Authorization header or urlToken)
      if (!token || !token.startsWith("Bearer ")) {
        if (urlToken) {
          token = urlToken;
        } else {
          return res.status(401).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, invalid token format"],
          });
        }
      } else {
        token = token.split(" ")[1];
      }

      try {
        // I verify the JWT signature and expiration
        const { userId, roles, workerId } = jwt.verify(
          token,
          process.env.SECRETORPRIVATEKEY || "tokenTest"
        ) as IPayload;

        req.userId = userId;
        req.workerId = workerId;

        // Role validation
        if (allowedRoles && !roles.some((r) => allowedRoles.includes(r))) {
          return res.status(403).json({
            header: { success: false, authenticated: true },
            messages: ["Access denied, role not allowed"],
          });
        }

        // I fetch the user and check token match
        const user = await User.findOne({
          where: { id: userId, available: true },
        });

        if (!user) {
          return res.status(408).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, token revoked or not recognized"],
          });
        }

        // 🔹 Key point: I ensure the token from the request matches the one stored in DB
        if (user.auth_token !== token) {
          return res.status(408).json({
            header: { success: false, authenticated: false },
            messages: ["Access denied, token revoked or not recognized"],
          });
        }

        // If everything is fine, I let the request continue
        next();
      } catch (error) {
        return res.status(401).json({
          header: { success: false, authenticated: false },
          messages: ["Access denied, invalid or expired token"],
        });
      }
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        header: { success: false, authenticated: false },
        messages: ["Internal server error"],
      });
    }
  };
};

export default TokenValidation;
