import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const myNotifications = async (req: Request, res: Response) => {
  try {
    const notifications = await repository.myNotifications(req.userId);
    return formatResponse({ res: res, success: true, body: notifications });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
