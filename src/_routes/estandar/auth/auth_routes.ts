import Router from "express";
import {
  validateEmail,
  verifyEmailCode,
  signUp,
  login,
  requestRestorePassword,
  validateRestorePassword,
  restorePassword,
  validatePhone,
  changePass,
} from "../../../useCases/auth/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";
const router = Router();
router.post("/validate/email", validateEmail);
router.post("/verify/email", verifyEmailCode);
router.post("/", signUp);
router.post("/image", signUp);
router.post("/login", login);
router.post("/restore/request", requestRestorePassword);
router.post("/restore/validate", validateRestorePassword);
router.post("/restore", restorePassword);
router.patch("/change_pass", TokenValidation(), changePass);
router.post("/phone/validate", validatePhone);
export default router;
