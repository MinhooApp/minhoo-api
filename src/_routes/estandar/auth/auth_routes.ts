import Router from "express";
import User from "../../../_models/user/user";
import {
  validateEmail,
  verifyEmailCode,
  signUp,
  login,
  logout,
  logoutDevice,
  saveDeviceToken,
  requestRestorePassword,
  validateRestorePassword,
  restorePassword,
  validatePhone,
  changePass,
  validateSesion,
} from "../../../useCases/auth/_controller/controller";
import { TokenValidation } from "../../../libs/middlewares/verify_jwt";

const router = Router();

/**
 * Middleware: antes del login revisa si el usuario está deshabilitado
 * (bloqueado por el admin). Si está disabled, NO deja entrar.
 */
const checkDisabledBeforeLogin = async (req: any, res: any, next: any) => {
  try {
    const { email, phone } = req.body;

    // Si no vienen credenciales, dejamos que el controlador maneje el error
    if (!email && !phone) {
      return next();
    }

    const where: any = {};
    if (email) where.email = email;
    if (phone) where.phone = phone;

    const user = await User.findOne({ where });

    // Si existe y está deshabilitado, bloqueamos el login
    const disabledValue = (user as any)?.disabled;
    const isDisabled =
      disabledValue === true ||
      disabledValue === 1 ||
      disabledValue === "1";
    const isDeleted = (user as any)?.is_deleted === true || (user as any)?.is_deleted === 1;

    if (user && (isDisabled || isDeleted)) {
      return res.status(403).json({
        header: { success: false },
        body: {
          message: isDeleted
            ? "Tu cuenta ha sido eliminada."
            : "Tu cuenta ha sido bloqueada por el administrador.",
        },
      });
    }

    // Si no está deshabilitado, seguimos al controlador de login
    return next();
  } catch (err) {
    console.error("checkDisabledBeforeLogin error:", err);
    return res.status(500).json({
      header: { success: false },
      body: { message: "Internal server error" },
    });
  }
};

router.post("/validate/email", validateEmail);
router.post("/verify/email", verifyEmailCode);
router.post("/", signUp);
router.post("/image", signUp);

router.post("/login", login);
router.post("/logout", TokenValidation(), logout);
router.post("/logout/device", logoutDevice);
router.post("/device-token", TokenValidation(), saveDeviceToken);
router.post("/session/logout", TokenValidation(), logout);
router.post("/signout", TokenValidation(), logout);

router.post("/restore/request", requestRestorePassword);
router.post("/restore/validate", validateRestorePassword);
router.post("/restore", restorePassword);
router.patch("/change_pass", TokenValidation(), changePass);
router.post("/phone/validate", validatePhone);
router.get("/session/validate", TokenValidation(), validateSesion);

export default router;
