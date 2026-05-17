import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import { bumpHomeNotificationsCacheVersion } from "../../../libs/cache/bootstrap_home_cache_version";
import logger from "../../../libs/logger/logger";

export const readNotification = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const body = {
      read: true,
    };

    await repository.update(req.userId, id, body);
    await bumpHomeNotificationsCacheVersion(req.userId);
    return formatResponse({ res: res, body: "read", success: true });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const deleteNotification = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const body = {
      read: true,
      deleted: true,
    };

    await repository.update(req.userId, id, body);
    await bumpHomeNotificationsCacheVersion(req.userId);
    return formatResponse({ res: res, body: "deleted", success: true });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res: res, success: false, message: error });
  }
};
