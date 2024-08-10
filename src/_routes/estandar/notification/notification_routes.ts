import Router from "express";
import { myNotifications } from "../../../useCases/notification/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();

router.get("/", TokenValidation(), myNotifications);

export default router;
