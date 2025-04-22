import Router from "express";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();
import {
  get,
  gets,
  myData,
  follow,
  follows,
  followers,
  activeAlerts,
} from "../../../useCases/user/_controller/controller";
router.get("/", TokenValidation(), gets);
router.post("/follow", TokenValidation(), follow);
router.get("/follows/:id?", follows);
router.get("/followers/:id?", followers);
router.get("/one/:id?", get);
router.get("/myData", TokenValidation(), myData);
router.get("/alert", TokenValidation(), activeAlerts);
export default router;
