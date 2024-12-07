import Router from "express";
import {
  validateEmail,
  verifyEmailCode,
  signUp,
  login,
  requestRestorePassword,
  validateRestorePassword,
  restorePassword,
} from "../../../useCases/auth/_controller/controller";
const router = Router();
router.post("/validate/email", validateEmail);
router.post("/verify/email", verifyEmailCode);
router.post("/", signUp);
router.post("/image", signUp);
router.post("/login", login);
router.post("/restore/request", requestRestorePassword);
router.post("/restore/validate", validateRestorePassword);
router.post("/restore", restorePassword);

export default router;
