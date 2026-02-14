import Router from "express";
import {
  myNotifications,
  readNotification,
  deleteNotification,
} from "../../../useCases/notification/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();

router.get("/", TokenValidation(), myNotifications);
router.get("/:id", TokenValidation(), readNotification);
router.patch("/:id", TokenValidation(), deleteNotification);
export default router;
