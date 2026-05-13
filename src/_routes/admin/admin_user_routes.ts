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
  admin_get_user,
  admin_list_users,
  admin_location_summary,
  admin_update_birthdate,
  admin_disable_account,
  admin_enable_account,
  admin_restore_account,
  admin_list_mural_posts,
  admin_list_mural_services,
  admin_mural_services_location_summary,
  admin_list_mural_reels,
  admin_list_user_posts,
  admin_get_user_post,
  admin_list_user_post_comments,
  admin_delete_user_post,
  admin_list_user_service_offers,
  admin_delete_user_service,
  admin_list_user_reels,
  admin_get_user_reel,
  admin_list_user_reel_comments,
  admin_delete_user_reel,
} from "../../useCases/admin/users/admin_users";
import {
  admin_force_approve_profile_verification,
  admin_list_profile_verification_queue,
  admin_revoke_profile_verification,
  admin_review_profile_verification_request,
} from "../../useCases/user/verification/profile_verification";
import {
  followers_v2,
  following_v2,
} from "../../useCases/user/_controller/controller";

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
 * ✅ Lista admin de usuarios con filtros.
 * Endpoint:
 * GET /api/v1/admin/users?page=1&limit=20&q=&status=all|active|disabled|deleted|directory&verified=all&role=worker&country_id=&state_id=&city_id=
 */
router.get(
  "/",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_users
);

/**
 * ✅ Resumen geográfico admin (país/estado/ciudad).
 * Endpoint:
 * GET /api/v1/admin/users/location/summary?status=all|active|disabled|deleted|directory&verified=all&role=worker&country_id=&state_id=&city_id=
 */
router.get(
  "/location/summary",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_location_summary
);

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

/**
 * ✅ Actualiza fecha de nacimiento/edad manualmente.
 * Endpoint: PATCH /api/v1/admin/users/:id/birthdate
 */
router.patch(
  "/:id/birthdate",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_update_birthdate
);

/**
 * ✅ Lista de verificaciones pendientes/revisión manual.
 * Endpoint: GET /api/v1/admin/users/profile-verification/queue
 */
router.get(
  "/profile-verification/queue",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_profile_verification_queue
);

/**
 * ✅ Revisión manual de verificación de perfil.
 * Endpoint: PATCH /api/v1/admin/users/profile-verification/:requestId/review
 */
router.patch(
  "/profile-verification/:requestId/review",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_review_profile_verification_request
);

/**
 * ✅ Aprobación forzada por usuario (sin documentos si aplica).
 * Endpoint: PATCH /api/v1/admin/users/profile-verification/:userId/approve
 */
router.patch(
  "/profile-verification/:userId/approve",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_force_approve_profile_verification
);

/**
 * ✅ Revoca badge verificado por usuario.
 * Endpoint: PATCH /api/v1/admin/users/profile-verification/:userId/revoke
 */
router.patch(
  "/profile-verification/:userId/revoke",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_revoke_profile_verification
);

/**
 * ✅ Lista global de publicaciones (mural) para dashboard admin.
 * Endpoint: GET /api/v1/admin/users/mural/posts?page=1&limit=20&include_deleted=0
 */
router.get(
  "/mural/posts",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_mural_posts
);

/**
 * ✅ Lista global de ofertas de trabajo (services) para dashboard admin.
 * Endpoint: GET /api/v1/admin/users/mural/services?page=1&limit=20&status=all&include_deleted=0
 */
router.get(
  "/mural/services",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_mural_services
);

/**
 * ✅ Resumen de filtros del mural de services.
 * Endpoint: GET /api/v1/admin/users/mural/services/location/summary
 */
router.get(
  "/mural/services/location/summary",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_mural_services_location_summary
);

/**
 * ✅ Lista global de videos (reels) para dashboard admin.
 * Endpoint: GET /api/v1/admin/users/mural/reels?page=1&limit=20&include_deleted=0
 */
router.get(
  "/mural/reels",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_mural_reels
);

/**
 * ✅ Lista admin de seguidores de un usuario.
 * Endpoint: GET /api/v1/admin/users/:id/followers?limit=20&cursor=
 */
router.get(
  "/:id/followers",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  followers_v2
);

/**
 * ✅ Lista admin de seguidos (following) de un usuario.
 * Endpoint: GET /api/v1/admin/users/:id/following?limit=20&cursor=
 */
router.get(
  "/:id/following",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  following_v2
);

/**
 * ✅ Lista admin de publicaciones por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/posts?page=1&limit=20&include_deleted=0
 */
router.get(
  "/:id/posts",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_user_posts
);

/**
 * ✅ Detalle admin de publicación por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/posts/:postId
 */
router.get(
  "/:id/posts/:postId",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_get_user_post
);

/**
 * ✅ Lista admin de comentarios de publicación por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/posts/:postId/comments
 */
router.get(
  "/:id/posts/:postId/comments",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_user_post_comments
);

/**
 * ✅ Eliminar publicación de usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/posts/:postId
 */
router.delete(
  "/:id/posts/:postId",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_delete_user_post
);

/**
 * ✅ Lista postulantes de un service para admin.
 * Endpoint: GET /api/v1/admin/users/:id/services/:serviceId/offers
 */
router.get(
  "/:id/services/:serviceId/offers",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_user_service_offers
);

/**
 * ✅ Eliminar service de usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/services/:serviceId
 */
router.delete(
  "/:id/services/:serviceId",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_delete_user_service
);

/**
 * ✅ Lista admin de videos (reels) por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/reels?page=1&limit=20&include_deleted=0
 */
router.get(
  "/:id/reels",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_user_reels
);

/**
 * ✅ Detalle admin de video (reel) por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/reels/:reelId
 */
router.get(
  "/:id/reels/:reelId",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_get_user_reel
);

/**
 * ✅ Lista admin de comentarios de reel por usuario.
 * Endpoint: GET /api/v1/admin/users/:id/reels/:reelId/comments
 */
router.get(
  "/:id/reels/:reelId/comments",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_list_user_reel_comments
);

/**
 * ✅ Eliminar reel de usuario desde admin.
 * Endpoint: DELETE /api/v1/admin/users/:id/reels/:reelId
 */
router.delete(
  "/:id/reels/:reelId",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_delete_user_reel
);

/**
 * ✅ Detalle admin de un usuario.
 * Endpoint: GET /api/v1/admin/users/:id
 */
router.get(
  "/:id",
  TokenValidation(),
  EnsureAdmin(),
  adminActionLimiter,
  admin_get_user
);

export default router;
