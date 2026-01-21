import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

const parseBlockedId = (req: Request): number | null => {
  const raw = (req.params as any)?.blocked_id;
  const blockedId = Number(raw);
  return Number.isFinite(blockedId) ? blockedId : null;
};

export const block_user = async (req: Request, res: Response) => {
  try {
    const blockedId = parseBlockedId(req);

    if (blockedId === null) {
      return formatResponse({
        res,
        success: false,
        message: { success: false, message: "blocked_id must be a valid number" },
      });
    }

    const response = await repository.block_user(req.userId, blockedId);

    return formatResponse({
      res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};

export const unblock_user = async (req: Request, res: Response) => {
  try {
    const blockedId = parseBlockedId(req);

    if (blockedId === null) {
      return formatResponse({
        res,
        success: false,
        message: { success: false, message: "blocked_id must be a valid number" },
      });
    }

    const response = await repository.unblock_user(req.userId, blockedId);

    return formatResponse({
      res,
      success: true,
      message: response,
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
