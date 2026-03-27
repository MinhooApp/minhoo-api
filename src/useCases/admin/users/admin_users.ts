import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../../user/_module/module";
import { writeSecurityAuditFromRequest } from "../../../libs/security/security_audit_log";

const toOptionalPositiveInt = (value: any) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

const readActorUserId = (req: Request) => toOptionalPositiveInt((req as any)?.userId);
const readTargetUserId = (req: Request) => toOptionalPositiveInt((req.params as any)?.id);

/**
 * 🔒 Desactiva una cuenta a nivel empresa (no podrá usar el app).
 */
export const admin_disable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_set_disabled?.(id, true);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.disable",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        requestedDisabled: true,
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: true },
    });
  } catch (error) {
    console.error("admin_disable_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.disable",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta previamente desactivada.
 */
export const admin_enable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_set_disabled?.(id, false);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.enable",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        requestedDisabled: false,
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: false },
    });
  } catch (error) {
    console.error("admin_enable_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.enable",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta eliminada (soft delete).
 */
export const admin_restore_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const actorUserId = readActorUserId(req);
    const targetUserId = readTargetUserId(req);

    const result = await (repository as any).admin_restore_deleted?.(id);
    const notFound = Boolean((result as any)?.notFound);

    writeSecurityAuditFromRequest(req, {
      event: "admin.user.restore",
      level: notFound ? "warn" : "info",
      actorUserId,
      targetUserId,
      success: !notFound,
      reason: notFound ? "target_not_found" : "ok",
      meta: {
        notFound,
      },
    });

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, restored: true },
    });
  } catch (error) {
    console.error("admin_restore_account error:", error);
    writeSecurityAuditFromRequest(req, {
      event: "admin.user.restore",
      level: "error",
      actorUserId: readActorUserId(req),
      targetUserId: readTargetUserId(req),
      success: false,
      reason: "exception",
      meta: {
        message: (error as any)?.message ?? String(error),
      },
    });
    return formatResponse({ res, success: false, message: error });
  }
};
