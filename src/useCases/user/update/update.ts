import {
  Request,
  Response,
  formatResponse,
  repository,
  followerRepo,
  sendNotification,
} from "../_module/module";

export const activeAlerts = async (req: Request, res: Response) => {
  try {
    const userTemp = await repository.get(req.userId);
    if (userTemp == null) {
      return formatResponse({
        res: res,
        success: false,
        message: "user not found",
      });
    }
    const user = await repository.activeAlerts(req.userId);
    return formatResponse({ res: res, success: true, body: { user } });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
