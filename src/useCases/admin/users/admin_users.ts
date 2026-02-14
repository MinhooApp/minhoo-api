import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../../user/_module/module";

/**
 * 🔒 Desactiva una cuenta a nivel empresa (no podrá usar el app).
 */
export const admin_disable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await (repository as any).admin_set_disabled?.(id, true);

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: true },
    });
  } catch (error) {
    console.error("admin_disable_account error:", error);
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta previamente desactivada.
 */
export const admin_enable_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await (repository as any).admin_set_disabled?.(id, false);

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, disabled: false },
    });
  } catch (error) {
    console.error("admin_enable_account error:", error);
    return formatResponse({ res, success: false, message: error });
  }
};

/**
 * ✅ Reactiva una cuenta eliminada (soft delete).
 */
export const admin_restore_account = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await (repository as any).admin_restore_deleted?.(id);

    return formatResponse({
      res,
      success: true,
      message: result ?? { id, restored: true },
    });
  } catch (error) {
    console.error("admin_restore_account error:", error);
    return formatResponse({ res, success: false, message: error });
  }
};
