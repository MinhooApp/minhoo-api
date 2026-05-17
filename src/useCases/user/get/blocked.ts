import { Request, Response, formatResponse, repository } from "../_module/module";
import logger from "../../../libs/logger/logger";

export const get_blocked_users = async (req: Request, res: Response) => {
  try {
    const users = await repository.get_blocked_users(req.userId);

    return formatResponse({
      res,
      success: true,
      body: { users },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({ res, success: false, message: error });
  }
};
