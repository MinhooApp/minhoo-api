import {
  login,
  logout,
  logoutDevice,
  changePass,
  validateSesion,
} from "../login/login";
import { validateRestorePassword } from "../signUp/signUp";
import {
  validateEmail,
  signUp,
  verifyEmailCode,
  requestRestorePassword,
  restorePassword,
  validatePhone,
} from "../signUp/signUp";

export {
  validateEmail,
  verifyEmailCode,
  signUp,
  login,
  logout,
  logoutDevice,
  changePass,
  requestRestorePassword,
  validateRestorePassword,
  restorePassword,
  validatePhone,
  validateSesion,
};
