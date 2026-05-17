import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";
import logger from "../../../libs/logger/logger";

export const activeUser = async (req: Request, res: Response) => {
  try {
    const userTemp = await repository.get(req.params.id);

    if (userTemp == null) {
      return formatResponse({
        res,
        success: false,
        message: "user not found",
      });
    }

    const user = await repository.activeUser(req.params.id);

    return formatResponse({
      res,
      success: true,
      body: { user },
    });
  } catch (error) {
    logger.error({ event: "error", error: String(error), stack: (error as Error)?.stack });
    return formatResponse({
      res,
      success: false,
      message: error,
    });
  }
};
