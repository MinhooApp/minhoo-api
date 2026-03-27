// ================================================================
// File: src/_routes/admin/admin_user_routes.ts
// Description: Rutas exclusivas para administradores de Minhoo
// Funciones: Desactivar y reactivar usuarios a nivel empresa
// ================================================================

import { Router } from "express";
import TokenValidation from "../../libs/middlewares/verify_jwt";
import EnsureAdmin from "../../libs/middlewares/ensure_admin";
import { createRequestRateLimiter } from "../../libs/middlewares/request_rate_limiter";
import { writeSecurityAuditFromRequest } from "../../libs/security/security_audit_log";
import {
  admin_disable_account,
  admin_enable_account,
  admin_restore_account,
} from "../../useCases/admin/users/admin_users";

const router = Router();

const parsePositiveInt = (value: any, fallback: number, min = 1) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return fallback;
  return rounded;
};

const normalizeIp = (rawIp: any) => {
  const ip = String(rawIp ?? "").trim();
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice("::ffff:".length);
  return ip;
};

const ADMIN_ACTION_RATE_WINDOW_MS = parsePositiveInt(
  process.env.ADMIN_ACTION_RATE_WINDOW_MS,
  60_000
);
const ADMIN_ACTION_RATE_MAX = parsePositiveInt(
  process.env.ADMIN_ACTION_RATE_MAX,
  20
);
const ADMIN_ACTION_RATE_BLOCK_MS = parsePositiveInt(
  process.env.ADMIN_ACTION_RATE_BLOCK_MS,
  5 * 60_000,
  0
);
const ADMIN_ACTION_RATE_MAX_ENTRIES = parsePositiveInt(
  process.env.ADMIN_ACTION_RATE_MAX_ENTRIES,
  5_000,
  500
);

const adminActionLimiter = createRequestRateLimiter({
  windowMs: ADMIN_ACTION_RATE_WINDOW_MS,
  max: ADMIN_ACTION_RATE_MAX,
  blockDurationMs: ADMIN_ACTION_RATE_BLOCK_MS,
  maxEntries: ADMIN_ACTION_RATE_MAX_ENTRIES,
  keyPrefix: "admin:user:actions",
  message: "too many admin account actions, try later",
  keyGenerator: (req) => {
    const actorId = Number((req as any)?.userId ?? 0);
    const ip = normalizeIp(req.ip ?? (req as any)?.socket?.remoteAddress);
    return `${Number.isFinite(actorId) && actorId > 0 ? actorId : "unknown"}:${ip}`;
  },
  onLimit: (context) => {
    writeSecurityAuditFromRequest(context.req, {
      event: "admin.user.rate_limited",
      level: "warn",
      actorUserId: Number((context.req as any)?.userId ?? 0),
      success: false,
      reason: "rate_limit",
      meta: {
        keyPrefix: context.keyPrefix,
        hits: context.hits,
        limit: context.limit,
        retryAfterSeconds: context.retryAfterSeconds,
      },
    });
  },
});

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
  adminActionLimiter,
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
  adminActionLimiter,
  admin_enable_account
);

/**
 * ✅ Reactiva una cuenta eliminada (soft delete).
 * Endpoint: PATCH /api/v1/admin/users/:id/restore
 */
router.patch(
  "/:id/restore",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_restore_account
);

export default router;
