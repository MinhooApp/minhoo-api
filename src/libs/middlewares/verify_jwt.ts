import { Request, Response, NextFunction, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import User from "../../_models/user/user";

interface IPayload {
    id: string;
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

            if (!token || !token.startsWith("Bearer ")) {
                if (urlToken) {
                    token = urlToken;
                } else {
                    return res.status(401).json({
                        header: {
                            success: false,
                            authenticated: false,
                        },
                        messages: ["Access denied, invalid token format"],
                    });
                }
            } else {
                token = token.split(" ")[1];
            }

            try {
                const { id, roles } = jwt.verify(
                    token,
                    process.env.SECRETORPRIVATEKEY || "tokenTest",
                ) as IPayload;

                req.userId = id;

                if (allowedRoles && !roles.some((r) => allowedRoles.includes(r))) {
                    return res.status(403).json({
                        header: {
                            success: false,
                            authenticated: true,
                        },
                        messages: ["Access denied, role not allowed"],
                    });
                }

                const user = await User.findOne({
                    where: {
                        id: id,
                    },
                });

                if (!user) {
                    return res.status(401).json({
                        header: {
                            success: false,
                            authenticated: false,
                        },
                        messages: ["Access denied, User not found"],
                    });
                }

                if (!user.available) {
                    return res.status(401).json({
                        header: {
                            success: false,
                            authenticated: false,
                        },
                        messages: ["Access denied, User not available"],
                    });
                }

                next();
            } catch (error) {
                return res.status(401).json({
                    header: {
                        success: false,
                        authenticated: false,
                    },
                    messages: ["Access denied, invalid token"],
                });
            }

        } catch (error) {
            console.log(error);
        }
    }
};

export default TokenValidation;