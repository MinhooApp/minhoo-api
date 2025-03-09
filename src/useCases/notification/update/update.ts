import {
  Request,
  Response,
  formatResponse,
  repository,
} from "../_module/module";

export const readNotification = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const body = {
      read: true,
    };

    await repository.update(id, body);
    return formatResponse({ res: res, body: "read", success: true });
  } catch (error) {
    console.log(error);
    return formatResponse({ res: res, success: false, message: error });
  }
};
