import Router from "express";
import {
  validateEmail,
  verifyEmailCode,
  signUpWithImage,
  login,
} from "../../../useCases/auth/_controller/controller";
const router = Router();
router.post("/validate/email", validateEmail);
router.post("/verify/email", verifyEmailCode);
router.post("/", signUpWithImage);
router.post("/image", signUpWithImage);
router.post("/login", login);

export default router;
