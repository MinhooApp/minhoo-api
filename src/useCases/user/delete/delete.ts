import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const block_user = async (req: Request, res: Response) => {
  try {
    const { blocked_id } = req.params;
    const response = await repository.block_user(req.userId, blocked_id);

    return formatResponse({
      res: res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};

export const unblock_user = async (req: Request, res: Response) => {
  try {
    const { blocked_id } = req.params;
    const response = await repository.unblock_user(req.userId, blocked_id);

    return formatResponse({
      res: res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
