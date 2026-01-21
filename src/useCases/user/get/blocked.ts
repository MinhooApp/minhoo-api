import { Request, Response, formatResponse, repository } from "../_module/module";

export const get_blocked_users = async (req: Request, res: Response) => {
  try {
    const users = await repository.get_blocked_users(req.userId);

    return formatResponse({
      res,
      success: true,
      body: { users },
    });
  } catch (error) {
    console.log(error);
    return formatResponse({ res, success: false, message: error });
  }
};
