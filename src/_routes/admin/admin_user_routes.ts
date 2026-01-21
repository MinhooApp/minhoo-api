// ================================================================
// File: src/_routes/admin/admin_user_routes.ts
// Description: Rutas exclusivas para administradores de Minhoo
// Funciones: Desactivar y reactivar usuarios a nivel empresa
// ================================================================

import { Router } from "express";
import TokenValidation from "../../libs/middlewares/verify_jwt";
import EnsureAdmin from "../../libs/middlewares/ensure_admin";
import {
  admin_disable_account,
  admin_enable_account,
} from "../../useCases/admin/users/admin_users";

const router = Router();

/**
 * 🔒 Deshabilita (bloquea) una cuenta a nivel empresa.
 * - Solo los administradores pueden realizar esta acción.
 * - El usuario deshabilitado no podrá iniciar sesión ni usar el app.
 * Endpoint: DELETE /api/v1/admin/users/:id/disable
 */
router.delete(
  "/:id/disable",
  TokenValidation(),  // valida el token JWT
  EnsureAdmin(),      // asegura que el rol sea admin o superadmin
  admin_disable_account
);

/**
 * ✅ Reactiva (habilita nuevamente) una cuenta desactivada.
 * - Solo los administradores pueden realizar esta acción.
 * Endpoint: DELETE /api/v1/admin/users/:id/enable
 */
router.delete(
  "/:id/enable",
  TokenValidation(),
  EnsureAdmin(),
  admin_enable_account
);

export default router;
