import { Router, Request, Response } from "express";
import TokenValidation from "../libs/middlewares/verify_jwt";
import { disableUser, enableUser } from "./admin_users";

const router = Router();

// Deshabilitar usuario
router.delete(
  "/users/:id/disable",
  TokenValidation([8088]),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = await disableUser(id);
      if (!user) {
        return res.status(404).json({
          header: { success: false, authenticated: true },
          messages: ["user not found"],
          body: {},
        });
      }
      return res.json({
        header: { success: true, authenticated: true },
        body: { user },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({
        header: { success: false, authenticated: true },
        messages: ["internal error"],
        body: {},
      });
    }
  }
);

// Habilitar usuario
router.delete(
  "/users/:id/enable",
  TokenValidation([8088]),
  async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const user = await enableUser(id);
      if (!user) {
        return res.status(404).json({
          header: { success: false, authenticated: true },
          messages: ["user not found"],
          body: {},
        });
      }
      return res.json({
        header: { success: true, authenticated: true },
        body: { user },
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({
        header: { success: false, authenticated: true },
        messages: ["internal error"],
        body: {},
      });
    }
  }
);

export default router;
