import Router from "express";
import {
  myNotifications,
  readNotification,
} from "../../../useCases/notification/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();

router.get("/", TokenValidation(), myNotifications);
router.get("/:id", TokenValidation(), readNotification);
export default router;
